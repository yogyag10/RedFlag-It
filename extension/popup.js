const $ = (id) => document.getElementById(id);
const sections = ["intro", "loading", "error", "result"];
let activeListing = null;
let currentVote = null;
const show = (active) => sections.forEach((name) => $(name).classList.toggle("hidden", name !== active));

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) throw new Error("Open a rental listing first.");
  const supported = /https:\/\/(?:[^/]+\.craigslist\.org|www\.facebook\.com\/marketplace)\//i.test(tab.url);
  if (!supported) throw new Error("Open a Craigslist or Facebook Marketplace listing.");
  return tab;
}

async function extract(tab) {
  try {
    const reply = await chrome.tabs.sendMessage(tab.id, { type: "RENTAL_SHIELD_EXTRACT" });
    if (reply?.ok) return reply.listing;
  } catch (_) {}
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
  const reply = await chrome.tabs.sendMessage(tab.id, { type: "RENTAL_SHIELD_EXTRACT" });
  if (!reply?.ok) throw new Error(reply?.error || "Could not read this listing.");
  return reply.listing;
}

async function analyze() {
  show("loading");
  try {
    const tab = await currentTab();
    activeListing = await extract(tab);
    if (!activeListing.title && !activeListing.description) throw new Error("No listing text found. Open the full listing and try again.");
    const { apiUrl = "http://127.0.0.1:8000", apiKey = "" } = await chrome.storage.local.get(["apiUrl", "apiKey"]);
    const response = await fetch(`${apiUrl.replace(/\/+$/, "")}/api/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(activeListing),
      signal: AbortSignal.timeout(120000)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.detail || `Analysis service returned ${response.status}.`);
    render(payload);
  } catch (error) {
    $("error-copy").textContent = error.name === "TimeoutError"
      ? "The service took too long. Try again."
      : error.message || "Check your service settings and try again.";
    show("error");
  }
}

function setChip(id, state, label) {
  const chip = $(id);
  chip.dataset.state = state;
  chip.querySelector("b").textContent = label;
}

function photoCoverage(result, listing) {
  const found = listing?.image_urls?.length || 0;
  const processed = Number(result.photos_processed) || 0;
  if (processed > 0 && result.photo_text_match_available) {
    setChip("photo-check", "ready", "Match checked");
    return `Compared listing text with ${processed} processed photo${processed === 1 ? "" : "s"}.`;
  }
  if (processed > 0) {
    setChip("photo-check", "ready", "Images read");
    return `Processed ${processed} photo${processed === 1 ? "" : "s"}; text/photo matching was unavailable.`;
  }
  if (!found) {
    setChip("photo-check", "idle", "No photos");
    return "No usable public photo links were available on the page.";
  }
  setChip("photo-check", "partial", "Fetch failed");
  return `RedFlag found ${found} photo link${found === 1 ? "" : "s"}, but the local service could not download them. The page may show photos from your signed-in session that the service cannot access; RedFlag never sends your Facebook login session.`;
}

function localCoverage(baseline = {}, result = {}, listing = {}) {
  const count = Number(baseline.peer_count) || 0;
  if (result.price_comparison_available) {
    setChip("price-check", "ready", "Compared");
    return `Price pattern compared with ${count} nearby listing${count === 1 ? "" : "s"} in local history.`;
  }
  if (!listing.price) {
    setChip("price-check", "idle", "No price");
    return "No listing price was available for comparison.";
  }
  if (listing.latitude == null || listing.longitude == null) {
    setChip("price-check", "idle", "No location");
    return "Location coordinates were not available for comparison.";
  }
  if (count > 0) {
    setChip("price-check", "partial", "Need 10+");
    return `${count} nearby listing${count === 1 ? " was" : "s were"} available; 10 are needed for comparison.`;
  }
  const message = baseline.message || "No neighborhood listing history was available.";
  if (/not configured|could not be reached|failed/i.test(message)) {
    setChip("price-check", "partial", "Unavailable");
    return "Local listing history is unavailable right now.";
  }
  setChip("price-check", "idle", "No history");
  return "No nearby listing history is set up yet.";
}

function showSignalDetail(item) {
  $("signal-detail-title").textContent = item.title || "Review this detail";
  $("signal-detail-copy").textContent = item.detail || "This detail may need a closer look.";
  const evidence = $("signal-detail-evidence");
  if (item.evidence) {
    $("signal-evidence-source").textContent = item.evidence_source === "title" ? "Found in title" : "Found in description";
    $("signal-evidence-quote").textContent = item.evidence;
    evidence.classList.remove("hidden");
  } else {
    evidence.classList.add("hidden");
  }
  $("signal-detail-dialog").showModal();
}

function makeSignalCard(item, inDialog = false) {
  const severity = ["low", "medium", "high"].includes(item.severity) ? item.severity : "medium";
  const li = document.createElement("li");
  li.className = `signal-card severity-${severity}`;
  const button = document.createElement("button");
  button.className = "signal-button";
  button.type = "button";
  button.setAttribute("aria-haspopup", "dialog");
  const marker = document.createElement("span");
  marker.className = "signal-symbol";
  marker.setAttribute("aria-hidden", "true");
  marker.textContent = severity === "high" ? "!" : severity === "low" ? "i" : "•";
  const title = document.createElement("span");
  title.className = "signal-title";
  title.textContent = item.title || "Review this detail";
  const arrow = document.createElement("span");
  arrow.className = "signal-arrow";
  arrow.setAttribute("aria-hidden", "true");
  arrow.textContent = "›";
  button.append(marker, title, arrow);
  button.addEventListener("click", () => {
    if (inDialog) $("signals-dialog").close();
    showSignalDetail(item);
  });
  li.append(button);
  return li;
}

function render(result) {
  const score = Math.max(0, Math.min(100, Math.round(result.risk_score ?? 0)));
  const level = score >= 60 ? "high" : score >= 30 ? "medium" : "low";
  const card = $("score-card");
  card.dataset.level = level;
  $("score").textContent = String(score);
  $("score-ring").setAttribute("aria-label", `Signal score: ${score} out of 100`);
  $("level").textContent = result.risk_level || "Review signals";
  $("summary").textContent = level === "high"
    ? "Several signs need a closer look."
    : level === "medium"
      ? "Some details deserve a closer look."
      : "Few common warning signs found.";
  $("text-check").dataset.state = "ready";
  $("text-check").querySelector("b").textContent = "Checked";

  const circumference = 2 * Math.PI * 51;
  const arc = $("score-arc");
  arc.style.strokeDasharray = String(circumference);
  arc.style.strokeDashoffset = String(circumference);
  requestAnimationFrame(() => {
    arc.style.strokeDashoffset = String(circumference * (1 - score / 100));
  });

  const signals = $("signals");
  signals.replaceChildren();
  const items = Array.isArray(result.signals) ? result.signals : [];
  $("signal-count").textContent = String(items.length);
  if (!items.length) {
    const li = document.createElement("li");
    li.className = "empty-state";
    li.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 10 4 4 8-8"/></svg><span>No common warning signs found</span>';
    signals.append(li);
  }

  items.slice(0, 2).forEach((item) => signals.append(makeSignalCard(item)));
  const moreSignals = $("more-signals");
  moreSignals.classList.toggle("hidden", items.length <= 2);
  moreSignals.textContent = `View all ${items.length} signals`;
  const allSignals = $("all-signals");
  allSignals.replaceChildren(...items.map((item) => makeSignalCard(item, true)));

  $("coverage-text").textContent = "Text: scam-language rules checked the title and description.";
  $("coverage-photos").textContent = `Photos: ${photoCoverage(result, activeListing)}`;
  $("coverage-price").textContent = `Local data: ${localCoverage(result.baseline, result, activeListing)}`;
  currentVote = null;
  $("feedback-open").querySelector("span").textContent = "Give feedback";
  $("feedback-status").textContent = "";
  document.querySelectorAll(".vote-button").forEach((button) => {
    button.setAttribute("aria-pressed", "false");
  });
  show("result");
}

async function saveFeedback(vote, selectedButton) {
  const buttons = [...document.querySelectorAll(".vote-button")];
  buttons.forEach((button) => { button.disabled = true; });
  try {
    const stored = await chrome.storage.local.get("resultFeedback");
    const resultFeedback = stored.resultFeedback || {};
    const counts = {
      correct: Number(resultFeedback.correct) || 0,
      incorrect: Number(resultFeedback.incorrect) || 0
    };
    if (currentVote) counts[currentVote] = Math.max(0, counts[currentVote] - 1);
    counts[vote] += 1;
    await chrome.storage.local.set({ resultFeedback: counts });
    currentVote = vote;
    buttons.forEach((button) => button.setAttribute("aria-pressed", String(button === selectedButton)));
    $("feedback-status").textContent = "Saved on this device.";
    $("feedback-open").querySelector("span").textContent = "Feedback saved";
    $("feedback-dialog").close();
  } catch (_) {
    $("feedback-status").textContent = "Could not save feedback.";
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}

$("analyze").addEventListener("click", analyze);
$("retry").addEventListener("click", analyze);
$("again").addEventListener("click", analyze);
$("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("feedback-open").addEventListener("click", () => {
  $("feedback-status").textContent = "";
  $("feedback-dialog").showModal();
});
$("feedback-close").addEventListener("click", () => $("feedback-dialog").close());
$("feedback-dialog").addEventListener("click", (event) => {
  if (event.target === event.currentTarget) event.currentTarget.close();
});
$("coverage-open").addEventListener("click", () => $("coverage-dialog").showModal());
$("coverage-close").addEventListener("click", () => $("coverage-dialog").close());
$("coverage-dialog").addEventListener("click", (event) => {
  if (event.target === event.currentTarget) event.currentTarget.close();
});
$("more-signals").addEventListener("click", () => $("signals-dialog").showModal());
$("signals-close").addEventListener("click", () => $("signals-dialog").close());
$("signals-dialog").addEventListener("click", (event) => {
  if (event.target === event.currentTarget) event.currentTarget.close();
});
$("signal-detail-close").addEventListener("click", () => $("signal-detail-dialog").close());
$("signal-detail-dialog").addEventListener("click", (event) => {
  if (event.target === event.currentTarget) event.currentTarget.close();
});
document.querySelectorAll(".vote-button").forEach((button) => {
  button.addEventListener("click", () => saveFeedback(button.dataset.vote, button));
});
currentTab().then(() => { $("page-hint").textContent = "Marketplace listing detected"; })
  .catch((error) => {
    $("page-hint").textContent = error.message;
    $("analyze").disabled = true;
    $("analyze").querySelector("span").textContent = "Open a supported listing";
  });

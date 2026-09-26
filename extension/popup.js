const $ = (id) => document.getElementById(id);
const sections = ["intro", "loading", "error", "result"];
const show = (active) => sections.forEach((name) => $(name).classList.toggle("hidden", name !== active));

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) throw new Error("Open a Craigslist or Facebook Marketplace rental listing first.");
  const supported = /https:\/\/(?:[^/]+\.craigslist\.org|www\.facebook\.com\/marketplace)\//i.test(tab.url);
  if (!supported) throw new Error("This page isn’t supported yet. Open a Craigslist or Facebook Marketplace listing.");
  return tab;
}

async function extract(tab) {
  try {
    const reply = await chrome.tabs.sendMessage(tab.id, { type: "RENTAL_SHIELD_EXTRACT" });
    if (reply?.ok) return reply.listing;
  } catch (_) {}
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
  const reply = await chrome.tabs.sendMessage(tab.id, { type: "RENTAL_SHIELD_EXTRACT" });
  if (!reply?.ok) throw new Error(reply?.error || "Could not read listing details from the page.");
  return reply.listing;
}

async function analyze() {
  show("loading");
  try {
    const tab = await currentTab();
    const listing = await extract(tab);
    if (!listing.title && !listing.description) throw new Error("No listing text was found. Open the full listing details and try again.");
    const { apiUrl = "http://127.0.0.1:8000", apiKey = "" } = await chrome.storage.local.get(["apiUrl", "apiKey"]);
    const response = await fetch(`${apiUrl.replace(/\/+$/, "")}/api/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(listing),
      signal: AbortSignal.timeout(120000)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.detail || `Analysis service returned ${response.status}. Is it running?`);
    render(payload);
  } catch (error) {
    $("error-copy").textContent = error.name === "TimeoutError"
      ? "The analysis service took too long to respond. Try again in a moment."
      : error.message || "Check the service URL in Settings and try again.";
    show("error");
  }
}

function render(result) {
  const score = Math.max(0, Math.min(100, Math.round(result.risk_score ?? 0)));
  $("score").textContent = score;
  const ring = $("score-ring");
  ring.className = `score-ring ${score >= 60 ? "high" : score >= 30 ? "medium" : ""}`;
  $("level").textContent = result.risk_level || "Review signals";
  $("summary").textContent = result.summary || "Use these signals as a starting point for your own checks.";
  const signals = $("signals");
  signals.replaceChildren();
  const items = result.signals || [];
  $("signal-count").textContent = `${items.length} signal${items.length === 1 ? "" : "s"}`;
  if (!items.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No strong automated warning signs were found in the available listing details.";
    signals.append(li);
  }
  for (const item of items) {
    const li = document.createElement("li");
    const dot = document.createElement("span");
    dot.className = `dot ${item.severity || "medium"}`;
    const copy = document.createElement("div");
    const title = document.createElement("p");
    title.className = "signal-title";
    title.textContent = item.title || "Review this detail";
    const detail = document.createElement("p");
    detail.className = "signal-detail";
    detail.textContent = item.detail || "This detail may deserve a closer look.";
    copy.append(title, detail);
    li.append(dot, copy);
    signals.append(li);
  }
  const baseline = result.baseline || {};
  $("baseline").textContent = baseline.message || (baseline.peer_count
    ? `Price comparison used ${baseline.peer_count} previously analyzed nearby listing${baseline.peer_count === 1 ? "" : "s"}.`
    : "No local neighborhood history was available for price comparison.");
  show("result");
}

$("analyze").addEventListener("click", analyze);
$("retry").addEventListener("click", analyze);
$("again").addEventListener("click", analyze);
$("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
currentTab().then(() => { $("page-hint").textContent = "Works on Craigslist and Facebook Marketplace listings."; })
  .catch((error) => { $("page-hint").textContent = error.message; $("analyze").disabled = true; $("analyze").textContent = "Open a supported listing"; });

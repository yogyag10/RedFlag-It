const $ = (id) => document.getElementById(id);
const sections = ["intro", "loading", "error", "result"];
let activeListing = null;
let activeAnalysis = null;

function show(active) {
  document.body.dataset.zeroScore = "false";
  sections.forEach((name) => $(name).classList.toggle("hidden", name !== active));
}

function classify(score) {
  if (score >= 60) return { key: "possible", label: "Scam Possible" };
  if (score >= 30) return { key: "careful", label: "Be Careful" };
  return { key: "low", label: "Low Risk" };
}

function scoreOf(result = {}) {
  return Math.max(0, Math.min(100, Math.round(Number(result.risk_score) || 0)));
}

function hasVoteContract(payload) {
  const votes = payload?.votes;
  return typeof payload?.fake === "boolean"
    && Number.isInteger(votes?.fake)
    && Number.isInteger(votes?.real)
    && Number.isInteger(votes?.unknown)
    && votes.fake >= 0
    && votes.real >= 0
    && votes.unknown >= 0
    && votes.fake + votes.real + votes.unknown === 6
    && typeof payload.review_check_available === "boolean"
    && Array.isArray(payload.consensus_rules)
    && payload.consensus_rules.every((rule) => typeof rule === "string")
    && Array.isArray(payload.trees)
    && payload.trees.length === 6
    && payload.trees.every((tree) => typeof tree === "string" && /^(?:fake|real|unknown)\s*\|\s*[a-z0-9_]+\s*\|\s*\S/i.test(tree))
    && payload.fake === (votes.fake > votes.real);
}

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) throw new Error("Open a rental listing first.");
  const supported = /https:\/\/(?:(?:[a-z0-9-]+\.)*craigslist\.org|(?:www\.)?facebook\.com\/marketplace|(?:www\.)?furnishedfinder\.com)\//i.test(tab.url);
  if (!supported) throw new Error("Open a Craigslist, Facebook Marketplace, or Furnished Finder rental listing.");
  return tab;
}

async function pageReply(tab) {
  let reply;
  try {
    reply = await chrome.tabs.sendMessage(tab.id, { type: "RENTAL_SHIELD_EXTRACT" });
  } catch (_) {}
  if (!reply) {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    reply = await chrome.tabs.sendMessage(tab.id, { type: "RENTAL_SHIELD_EXTRACT" });
  }
  return reply;
}

async function extract(tab) {
  const reply = await pageReply(tab);
  if (reply?.ok) return reply.listing;
  if (reply?.kind === "search") {
    const error = new Error("Open a result to see the full listing check. Search card badges only scan visible card text.");
    error.pageKind = "search";
    throw error;
  }
  throw new Error(reply?.error || "Could not read this listing.");
}

function showSearchPage(tab) {
  const site = tab?.url?.includes("craigslist") ? "Craigslist"
    : tab?.url?.includes("furnishedfinder") ? "Furnished Finder"
      : "Marketplace";
  $("page-hint").textContent = `${site} search results`;
  $("intro-title").textContent = "Open a listing";
  $("intro-copy").textContent = "Card badges are quick text checks. Open a result to see its full score and reasons.";
  $("privacy-line").textContent = "Search results are not saved as listing checks.";
  $("analyze").disabled = true;
  $("analyze").textContent = "Open a listing for full check";
}

async function analyze() {
  show("loading");
  try {
    const tab = await currentTab();
    activeListing = await extract(tab);
    if (!activeListing.title && !activeListing.description) {
      throw new Error("No listing details found. Open the full listing and try again.");
    }
    const { apiUrl = "http://127.0.0.1:8000", apiKey = "" } = await chrome.storage.local.get(["apiUrl", "apiKey"]);
    const response = await fetch(`${apiUrl.replace(/\/+$/, "")}/api/analyze`, {
      method: "POST",
      credentials: "omit",
      headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(activeListing),
      signal: AbortSignal.timeout(120000)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.detail || `Analysis service returned ${response.status}.`);
    if (!hasVoteContract(payload)) {
      throw new Error("The backend response is missing the six safety factors. Update and restart the backend.");
    }
    activeAnalysis = payload;
    render(payload, activeListing);
    await saveRecent(payload, activeListing);
  } catch (error) {
    if (error.pageKind === "search") {
      const tab = await currentTab().catch(() => null);
      showSearchPage(tab);
      show("intro");
      return;
    }
    $("error-copy").textContent = error.name === "TimeoutError"
      ? "The check took too long. Try again."
      : error.message || "Check your service settings and try again.";
    show("error");
  }
}

function makeElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
}

const VOTE_RULE_LABELS = {
  payment_before_viewing: "Money before viewing",
  wire_or_irreversible_payment: "Hard-to-reverse payment",
  landlord_unavailable: "Landlord unavailable",
  verification_code: "Account code request",
  pressure_tactic: "Urgent pressure",
  review_checker: "Public seller reviews",
};

const ICON_SHAPES = {
  warning: [["path", { d: "M12 3 2.7 20h18.6L12 3Z" }], ["path", { d: "M12 9v5" }], ["circle", { cx: "12", cy: "17", r: ".7", fill: "currentColor", stroke: "none" }]],
  check: [["circle", { cx: "12", cy: "12", r: "9" }], ["path", { d: "m8 12 2.5 2.5L16.5 9" }]],
  info: [["circle", { cx: "12", cy: "12", r: "9" }], ["path", { d: "M12 11v5M12 8h.01" }]],
  payment: [["rect", { x: "3", y: "5", width: "18", height: "14", rx: "2" }], ["path", { d: "M3 10h18M7 15h4" }]],
  transfer: [["path", { d: "M4 8h14l-3-3M20 16H6l3 3" }]],
  landlord: [["circle", { cx: "12", cy: "8", r: "3" }], ["path", { d: "M5 20v-2a7 7 0 0 1 14 0v2" }]],
  code: [["rect", { x: "5", y: "3", width: "14", height: "18", rx: "2" }], ["path", { d: "M9 7h6M9 11h.01M12 11h.01M15 11h.01M9 15h.01M12 15h.01M15 15h.01" }]],
  pressure: [["circle", { cx: "12", cy: "12", r: "9" }], ["path", { d: "M12 7v5l3 2" }]],
  reviews: [["path", { d: "m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.8 1-6.1L3.2 9.4l6.1-.9L12 3Z" }]],
};

const RULE_ICONS = {
  payment_before_viewing: "payment",
  wire_or_irreversible_payment: "transfer",
  landlord_unavailable: "landlord",
  verification_code: "code",
  pressure_tactic: "pressure",
  review_checker: "reviews",
};

function makeIcon(name, extraClass = "") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", `rf-icon ${extraClass}`.trim());
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  for (const [tag, attributes] of ICON_SHAPES[name] || ICON_SHAPES.info) {
    const shape = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.entries(attributes).forEach(([key, value]) => shape.setAttribute(key, value));
    svg.append(shape);
  }
  return svg;
}

function parseTreeVote(value) {
  const [voteText = "", code = "", ...ruleParts] = String(value).split("|").map((part) => part.trim());
  const normalizedVote = voteText.toLowerCase();
  const vote = normalizedVote === "fake" || normalizedVote === "unknown" ? normalizedVote : "real";
  return { vote, code, rule: ruleParts.join(" | ") };
}

function buildVoteDetails(analysis, result = null) {
  const summary = result || analysis;
  const panel = makeElement("div", "room-details hidden vote-details");
  const votes = summary.votes || { fake: 0, real: 0 };
  const storedUnknown = Number.isInteger(votes.unknown);
  const unknownVotes = storedUnknown ? votes.unknown : summary.review_check_available === false ? 1 : 0;
  const realVotes = Math.max(0, votes.real - (!storedUnknown ? unknownVotes : 0));
  panel.dataset.verdict = summary.fake ? "fake" : "real";

  const tally = makeElement("div", "vote-tally");
  tally.setAttribute("role", "group");
  tally.setAttribute("aria-label", `${votes.fake} warning votes, ${realVotes} clear checks, ${unknownVotes} unknown checks`);
  const fakeCount = makeElement("span", "vote-count warning-count");
  fakeCount.append(makeIcon("warning"), makeElement("strong", "", String(votes.fake)), makeElement("span", "", "warning"));
  fakeCount.setAttribute("aria-label", `${votes.fake} warning votes`);
  const realCount = makeElement("span", "vote-count clear-count");
  realCount.append(makeIcon("check"), makeElement("strong", "", String(realVotes)), makeElement("span", "", "clear"));
  realCount.setAttribute("aria-label", `${realVotes} checks without a warning match`);
  const unknownCount = makeElement("span", "vote-count unknown-count");
  unknownCount.append(makeIcon("info"), makeElement("strong", "", String(unknownVotes)), makeElement("span", "", "unknown"));
  unknownCount.setAttribute("aria-label", `${unknownVotes} unknown checks`);
  tally.append(fakeCount, realCount, unknownCount);

  const ruleSection = makeElement("section", "detail-section vote-rule-section");
  const ruleHeading = makeElement("h3", "detail-heading");
  const rules = Array.isArray(summary.consensus_rules) ? summary.consensus_rules : [];
  ruleHeading.append(makeIcon(rules.length ? "warning" : "check"), makeElement("span", "", "Warning signs"));
  ruleSection.append(ruleHeading);
  if (rules.length) {
    const list = makeElement("ul", "vote-rule-list");
    rules.forEach((rule) => {
      const item = makeElement("li", "vote-rule-row");
      item.append(makeIcon("warning", "warning-icon"), makeElement("span", "", rule));
      item.setAttribute("aria-label", `Warning rule matched: ${rule}`);
      list.append(item);
    });
    ruleSection.append(list);
  } else {
    const item = makeElement("p", "no-rules");
    item.append(makeIcon("check", "clear-icon"), makeElement("span", "", "No warning rule matched"));
    ruleSection.append(item);
  }

  const breakdown = document.createElement("details");
  breakdown.className = "vote-breakdown";
  breakdown.open = true;
  const breakdownHeading = makeElement("summary");
  breakdownHeading.append(makeIcon("info"), makeElement("span", "", `${votes.fake + realVotes + unknownVotes} safety factors`));
  breakdown.append(breakdownHeading);
  const treeList = makeElement("ul", "vote-tree-list");
  const signalByCode = new Map((summary.signals || []).map((signal) => [signal.code, signal]));
  (Array.isArray(summary.trees) ? summary.trees : []).forEach((tree) => {
    const parsed = parseTreeVote(tree);
    const reviewUnavailable = parsed.code === "review_checker" && !summary.review_check_available;
    const reviewLabel = "Public seller reviews";
    const label = parsed.code === "review_checker"
      ? reviewLabel
      : VOTE_RULE_LABELS[parsed.code] || parsed.rule || "Rental warning check";
    const signalCode = parsed.code === "review_checker" ? "low_public_review_rating" : parsed.code;
    const signal = signalByCode.get(signalCode);
    const item = makeElement("li", "vote-tree-row");
    const unknownVote = reviewUnavailable || parsed.vote === "unknown";
    item.dataset.vote = unknownVote ? "unknown" : parsed.vote;
    item.append(
      makeIcon(RULE_ICONS[parsed.code] || "info", "tree-kind-icon"),
      makeIcon(unknownVote ? "info" : parsed.vote === "fake" ? "warning" : "check", `tree-vote-icon${unknownVote ? " unknown-icon" : ""}`),
      makeElement("span", "tree-title", label)
    );
    const noteParts = [];
    if (parsed.rule) noteParts.push(parsed.rule);
    if (signal?.detail) noteParts.push(signal.detail);
    if (signal?.evidence) noteParts.push(`Listing text: “${signal.evidence}”`);
    if (parsed.code === "review_checker") noteParts.push(summary.review_check_available
      ? "Visible seller rating checked; written review text and rental history are not checked."
      : "Seller review data was not visible or had too few ratings to assess; written review text and rental history are not checked.");
    if (noteParts.length) item.append(makeElement("small", "vote-tree-note", [...new Set(noteParts)].join(". ")));
    item.setAttribute("aria-label", unknownVote
      ? "Review information unavailable or too limited to assess."
      : `${parsed.vote === "fake" ? "Warning found" : "No warning found"}: ${label}`);
    treeList.append(item);
  });
  if (treeList.childElementCount) breakdown.append(treeList);
  else breakdown.append(makeElement("p", "legacy-votes", "Rule-vote details unavailable"));

  const note = makeElement("p", "vote-note", "Visible seller rating is checked. Written review text and rental history are not checked.");
  note.setAttribute("role", "note");
  panel.append(tally, ruleSection, breakdown, note);
  return panel;
}

function resultCard({ name, result, analysis, isRecent = false }) {
  const score = scoreOf(result);
  const status = classify(score);
  const card = makeElement("article", `room-card${isRecent ? " recent-card" : ""}`);
  card.dataset.status = status.key;
  card.dataset.zeroScore = String(score === 0);
  const heading = makeElement("h2", "room-heading", name || "Rental listing");
  const risk = makeElement("div", "risk-line");
  risk.append(
    makeIcon(status.key === "low" ? "check" : "warning", "risk-icon"),
    makeElement("strong", "risk-score", `${score} / 100`),
    makeElement("span", "risk-label", status.label)
  );
  const toggle = makeElement("button", "see-more");
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", "false");
  const toggleLabel = makeElement("span", "", "See details");
  toggle.append(makeIcon("info"), toggleLabel);
  toggle.setAttribute("aria-label", "See listing safety details");
  const details = buildVoteDetails(analysis, result);
  toggle.addEventListener("click", () => {
    const expanded = !details.classList.contains("hidden");
    details.classList.toggle("hidden", expanded);
    toggleLabel.textContent = expanded ? "See details" : "Hide details";
    toggle.setAttribute("aria-label", expanded ? "See listing safety details" : "Hide listing safety details");
    toggle.setAttribute("aria-expanded", String(!expanded));
  });
  card.append(heading, risk, toggle, details);
  return card;
}

function renderRoomOverview(results) {
  const overview = $("room-overview");
  const chips = $("room-chips");
  chips.replaceChildren();
  overview.classList.toggle("hidden", results.length < 2);
  if (results.length < 2) return;
  results.forEach((entry, index) => {
    const status = classify(scoreOf(entry.result));
    const chip = makeElement("button", "room-chip", `${entry.name} · ${scoreOf(entry.result)} / 100 · ${status.label}`);
    chip.type = "button";
    chip.dataset.status = status.key;
    chip.addEventListener("click", () => {
      $(`room-card-${index}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
    chips.append(chip);
  });
}

function render(analysis, listing) {
  const container = $("room-results");
  container.replaceChildren();
  const rooms = Array.isArray(analysis.room_results) ? analysis.room_results : [];
  const entries = rooms.length
    ? rooms.map((room) => ({ name: room.name, result: room }))
    : [{ name: listing.title || "Rental listing", result: analysis }];
  renderRoomOverview(entries);
  entries.forEach((entry, index) => {
    const card = resultCard({ ...entry, analysis, listing });
    card.id = `room-card-${index}`;
    container.append(card);
  });
  renderRecent();
  show("result");
  document.body.dataset.zeroScore = String(entries.every((entry) => scoreOf(entry.result) === 0));
}

function safeSnapshot(listing = {}) {
  return {
    title: listing.title || "Rental listing",
    bedrooms: listing.bedrooms ?? null,
    bathrooms: listing.bathrooms ?? null,
    price: listing.price ?? null,
    currency: listing.currency || "CAD",
    price_period: listing.price_period || "unknown",
    location_text: listing.location_text || "",
    listing_age: listing.listing_age || null,
    availability_text: listing.availability_text || null,
    profile_facts: Array.isArray(listing.profile_facts) ? listing.profile_facts.slice(0, 6) : [],
    rooms: Array.isArray(listing.rooms) ? listing.rooms.map((room) => ({
      name: room.name,
      price: room.price ?? null,
      bedrooms: room.bedrooms ?? null,
      bathrooms: room.bathrooms ?? null
    })) : []
  };
}

function isPlaceholderTitle(value) {
  return /^(?:chats?|messages?|marketplace|search results?|facebook|craigslist|rental listing|listing details?)$/i.test(String(value || "").trim());
}

function isLegacySearchEntry(check = {}) {
  if (check.listing_id) return false;
  const title = String(check.title || check.listing?.title || "").trim();
  const looksLikeSearch = /^(?:houses?|apartments?|rooms?|condos?|homes?)\s+(?:for\s+)?rent(?:als?)?$/i.test(title);
  const listing = check.listing || {};
  return looksLikeSearch
    && listing.price == null
    && listing.bedrooms == null
    && listing.bathrooms == null
    && !String(listing.location_text || "").trim();
}

function recentListingId(listing = {}) {
  try {
    const url = new URL(listing.source_url);
    const facebookId = url.pathname.match(/\/marketplace\/item\/(\d+)/)?.[1];
    const craigslistId = url.pathname.match(/\/(\d+)\.html$/)?.[1];
    return facebookId ? `facebook:${facebookId}` : craigslistId ? `craigslist:${craigslistId}` : `${url.hostname}${url.pathname}`;
  } catch (_) {
    return String(listing.title || "").trim().toLowerCase();
  }
}

async function saveRecent(analysis, listing) {
  try {
    const stored = await chrome.storage.local.get("recentChecks");
    const history = (Array.isArray(stored.recentChecks) ? stored.recentChecks : [])
      .filter((check) => !isPlaceholderTitle(check?.title || check?.listing?.title))
      .filter((check) => !isLegacySearchEntry(check))
      .filter((check) => check?.listing_id !== recentListingId(listing));
    const snapshot = safeSnapshot(listing);
    if (isPlaceholderTitle(snapshot.title)) return;
    const overall = analysis.room_results?.length
      ? analysis.room_results.reduce((riskiest, room) => scoreOf(room) > scoreOf(riskiest) ? room : riskiest)
      : analysis;
    history.unshift({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      listing_id: recentListingId(listing),
      checked_at: Date.now(),
      title: snapshot.title,
      listing: snapshot,
      analysis,
      overall
    });
    await chrome.storage.local.set({ recentChecks: history.slice(0, 5) });
    renderRecent();
  } catch (_) {}
}

function renderRecent() {
  const host = $("recent-checks");
  if (!host) return;
  host.replaceChildren();
  chrome.storage.local.get("recentChecks").then(({ recentChecks = [] }) => {
    const validChecks = (Array.isArray(recentChecks) ? recentChecks : [])
      .filter((check) => !isPlaceholderTitle(check?.title || check?.listing?.title))
      .filter((check) => !isLegacySearchEntry(check))
      .slice(0, 5);
    // Remove generic headings and old search-query entries that were mistaken
    // for listing titles, while keeping older checks with real listing facts.
    if (validChecks.length !== recentChecks.length) {
      chrome.storage.local.set({ recentChecks: validChecks }).catch(() => {});
    }
    if (!validChecks.length) {
      host.append(makeElement("p", "recent-empty", "Your recent checks will appear here."));
      return;
    }
    validChecks.forEach((check) => {
      host.append(resultCard({
        name: check.title,
        result: check.overall || check.analysis,
        analysis: check.analysis,
        listing: check.listing,
        isRecent: true
      }));
    });
  }).catch(() => host.append(makeElement("p", "recent-empty", "Recent checks are unavailable.")));
}

async function saveFeedback(vote, button) {
  document.querySelectorAll(".vote-button").forEach((item) => { item.disabled = true; });
  try {
    const stored = await chrome.storage.local.get("resultFeedback");
    const counts = stored.resultFeedback || { correct: 0, incorrect: 0 };
    counts[vote] = (Number(counts[vote]) || 0) + 1;
    await chrome.storage.local.set({ resultFeedback: counts });
    $("feedback-status").textContent = "Saved on this device.";
    $("feedback-dialog").close();
  } catch (_) {
    $("feedback-status").textContent = "Could not save feedback.";
  } finally {
    document.querySelectorAll(".vote-button").forEach((item) => { item.disabled = false; });
    button.setAttribute("aria-pressed", "true");
  }
}

$("analyze").addEventListener("click", analyze);
$("retry").addEventListener("click", analyze);
$("again").addEventListener("click", analyze);
$("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("feedback-open").addEventListener("click", () => $("feedback-dialog").showModal());
$("feedback-close").addEventListener("click", () => $("feedback-dialog").close());
$("feedback-dialog").addEventListener("click", (event) => {
  if (event.target === event.currentTarget) event.currentTarget.close();
});
document.querySelectorAll(".vote-button").forEach((button) => {
  button.addEventListener("click", () => saveFeedback(button.dataset.vote, button));
});
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.recentChecks) renderRecent();
});
currentTab().then(async (tab) => {
  const reply = await pageReply(tab);
  if (reply?.kind === "search") {
    showSearchPage(tab);
  } else if (reply?.ok || reply?.kind === "detail") {
    $("page-hint").textContent = "Rental listing detected";
  } else {
    throw new Error(reply?.error || "Could not read this page.");
  }
}).catch((error) => {
    $("page-hint").textContent = error.message;
    $("analyze").disabled = true;
    $("analyze").textContent = "Open a supported listing";
  });
renderRecent();

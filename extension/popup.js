const $ = (id) => document.getElementById(id);
const sections = ["intro", "loading", "error", "result"];
let activeListing = null;
let activeAnalysis = null;

function show(active) {
  sections.forEach((name) => $(name).classList.toggle("hidden", name !== active));
}

function classify(score) {
  if (score >= 60) return { key: "possible", label: "SCAM POSSIBLE" };
  if (score >= 30) return { key: "careful", label: "BE CAREFUL" };
  return { key: "low", label: "LOW RISK" };
}

function scoreOf(result = {}) {
  return Math.max(0, Math.min(100, Math.round(Number(result.risk_score) || 0)));
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
      headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(activeListing),
      signal: AbortSignal.timeout(120000)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.detail || `Analysis service returned ${response.status}.`);
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

function appendSection(parent, title) {
  const section = makeElement("section", "detail-section");
  section.append(makeElement("h3", "", title));
  parent.append(section);
  return section;
}

function appendBulletList(parent, items) {
  const list = makeElement("ul", "detail-list");
  items.forEach((item) => list.append(makeElement("li", "", item)));
  parent.append(list);
}

function priceText(listing = {}) {
  if (listing.price == null) return "Not shown";
  const currency = /^[A-Z]{3}$/.test(listing.currency || "") ? listing.currency : "CAD";
  try {
    const amount = new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 2 }).format(listing.price);
    return `${amount}${listing.price_period && listing.price_period !== "unknown" ? ` / ${listing.price_period}` : ""}`;
  } catch (_) {
    return `${listing.price} ${currency}`;
  }
}

function buildDetails(analysis, listing = {}, room = null, roomSignals = null) {
  const panel = makeElement("div", "room-details hidden");
  const signals = roomSignals || room?.signals || analysis.signals || [];
  const why = appendSection(panel, "Why RedFlag gave this score");
  if (!signals.length) {
    why.append(makeElement("p", "", "No specific warning signs were detected in the details RedFlag could read."));
  } else {
    const list = makeElement("ul", "detail-list");
    signals.forEach((signal) => {
      const item = makeElement("li");
      item.append(makeElement("strong", "", signal.title || "Listing detail to review"));
      if (signal.detail) item.append(makeElement("p", "", signal.detail));
      if (signal.evidence) item.append(makeElement("span", "evidence-quote", `Listing text: “${signal.evidence}”`));
      list.append(item);
    });
    why.append(list);
  }
  if (analysis.room_results?.length > 1) {
    const roomCodes = new Set(signals.map((signal) => signal.code));
    const listingSignals = (analysis.signals || []).filter((signal) => !roomCodes.has(signal.code));
    if (listingSignals.length) {
      const shared = appendSection(panel, "Whole-listing checks · not part of this room’s score");
      appendBulletList(shared, listingSignals.map((signal) => `${signal.title}: ${signal.detail}`));
    }
  }

  const believable = appendSection(panel, "How to Make It Believable");
  believable.append(makeElement("p", "verification-label", "UNVERIFIED · details shown on the listing"));
  const facts = [];
  if (listing.price != null) facts.push(["Price", priceText(listing)]);
  if (listing.bedrooms != null) facts.push(["Bedrooms", String(listing.bedrooms)]);
  if (listing.bathrooms != null) facts.push(["Bathrooms", String(listing.bathrooms)]);
  if (listing.location_text) facts.push(["Location", listing.location_text]);
  if (listing.address) facts.push(["Address", listing.address]);
  if (listing.listing_age) facts.push(["Listing age", listing.listing_age]);
  if (listing.availability_text) facts.push(["Availability", listing.availability_text]);
  if (facts.length) {
    facts.forEach(([label, value]) => {
      const row = makeElement("div", "fact-row");
      row.append(makeElement("span", "", label), makeElement("strong", "", value));
      believable.append(row);
    });
  } else {
    believable.append(makeElement("p", "", "No price, room, or location details were available to confirm."));
  }
  believable.append(makeElement("p", "", "These details come from the listing page. RedFlag has not confirmed that they are accurate."));

  const checked = appendSection(panel, "What RedFlag verified");
  checked.append(makeElement("p", "", "These are completed checks, not proof that the listing or its claims are genuine."));
  const checks = ["Listing text was checked for common rental warning signs."];
  if (analysis.photos_processed) checks.push(`${analysis.photos_processed} listing photo${analysis.photos_processed === 1 ? "" : "s"} processed.`);
  if (analysis.price_comparison_available) checks.push(`Price and location compared with ${Number(analysis.baseline?.peer_count) || 0} nearby records in RedFlag’s local history.`);
  appendBulletList(checked, checks);

  const comparisons = appendSection(panel, "Price comparison");
  if (analysis.price_comparison_available) {
    const count = Number(analysis.baseline?.peer_count) || 0;
    const roomNote = analysis.room_results?.length > 1 ? " Individual room prices were not compared separately." : "";
    comparisons.append(makeElement("p", "", `Compared with ${count} recent nearby listings saved in RedFlag’s local history. This is a signal to investigate, not a market valuation.${roomNote}`));
  } else {
    comparisons.append(makeElement("p", "", analysis.baseline?.message || "A nearby price comparison was not available."));
  }

  const history = appendSection(panel, "Profile and reviews");
  if (Array.isArray(listing.profile_facts) && listing.profile_facts.length) {
    appendBulletList(history, listing.profile_facts.map((fact) => `${fact} This is a platform display and was not independently verified.`));
  } else {
    history.append(makeElement("p", "", "Not enough public profile or review history was available to verify profile age, activity, or previous transactions."));
  }

  const furnishing = analysis.furnish_finder || {};
  const finder = appendSection(panel, "Furnish Finder");
  finder.append(makeElement("p", "", furnishing.summary || "A furnishing estimate was unavailable."));
  if (furnishing.likely_visible_items?.length) {
    appendBulletList(finder, furnishing.likely_visible_items.map((item) => `Likely visible: ${item}`));
  }
  if (furnishing.mentioned_items?.length) {
    appendBulletList(finder, furnishing.mentioned_items.map((item) => `Description mentions: ${item}`));
  }
  if (furnishing.not_confirmed_items?.length) {
    appendBulletList(finder, furnishing.not_confirmed_items.map((item) => `Not confirmed in these photos: ${item}`));
  }
  finder.append(makeElement("p", "", furnishing.note || "Photo estimates can miss items or mistake similar-looking objects."));
  if (analysis.room_results?.length > 1) {
    finder.append(makeElement("p", "", "Photos are from the whole listing and may not show which furniture belongs to this specific room."));
  }

  const unverified = appendSection(panel, "Still unverified");
  appendBulletList(unverified, [
    "Who owns the property or is authorized to rent it",
    "The exact address and whether the unit is available",
    "The identity and contact details of the person offering it",
    "Whether displayed profile information or reviews are genuine"
  ]);

  const nextSteps = appendSection(panel, "What to verify");
  appendBulletList(nextSteps, [
    "Visit the unit or arrange a live video tour.",
    "Verify the address and who is authorized to rent it.",
    "Read the lease and understand the payment process before sending money."
  ]);
  nextSteps.append(makeElement("p", "", "The risk score is a screening score, not a probability or a finding of fraud."));
  return panel;
}

function resultCard({ name, result, analysis, listing, roomInfo = null, isRecent = false }) {
  const score = scoreOf(result);
  const status = classify(score);
  const card = makeElement("article", `room-card${isRecent ? " recent-card" : ""}`);
  card.dataset.status = status.key;
  const heading = makeElement("h2", "room-heading", name || "Rental listing");
  const risk = makeElement("div", "risk-line");
  risk.append(makeElement("strong", "risk-score", `${score} / 100`), makeElement("span", "risk-label", status.label));
  const toggle = makeElement("button", "see-more", "See More");
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", "false");
  const detailListing = { ...listing };
  if (roomInfo) {
    for (const [key, value] of Object.entries(roomInfo)) {
      if (value != null && value !== "") detailListing[key] = value;
    }
    for (const key of ["price", "bedrooms", "bathrooms"]) {
      if (roomInfo[key] == null) detailListing[key] = null;
    }
  }
  const details = buildDetails(analysis, detailListing, roomInfo, result.signals);
  toggle.addEventListener("click", () => {
    const expanded = !details.classList.contains("hidden");
    details.classList.toggle("hidden", expanded);
    toggle.textContent = expanded ? "See More" : "See Less";
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
    ? rooms.map((room, index) => ({ name: room.name, result: room, roomInfo: listing.rooms?.[index] || null }))
    : [{ name: listing.title || "Rental listing", result: analysis, roomInfo: null }];
  renderRoomOverview(entries);
  entries.forEach((entry, index) => {
    const card = resultCard({ ...entry, analysis, listing });
    card.id = `room-card-${index}`;
    container.append(card);
  });
  renderRecent();
  show("result");
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

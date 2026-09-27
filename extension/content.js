(() => {
  if (window.__rentalShieldInstalled) return;
  window.__rentalShieldInstalled = true;

  const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
  const scoredCards = new Set();
  let observedPageUrl = "";
  let observedPageKind = "";
  let overlayHost = null;
  const firstText = (selectors) => {
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      const value = clean(node?.innerText || node?.textContent || node?.getAttribute("content"));
      if (value) return value;
    }
    return "";
  };

  const textLines = (node) => (node?.innerText || "").split(/\n+/).map(clean).filter(Boolean);

  function valueAfterLabel(lines, labelPattern) {
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!labelPattern.test(line)) continue;
      const inlineValue = line.replace(labelPattern, "").replace(/^\s*[:\-–·]\s*/, "").trim();
      if (inlineValue) return inlineValue;
      const next = lines.slice(index + 1).find((value) => value && !/^location is approximate$/i.test(value));
      if (next) return next.replace(/\s*[·|,]\s*location is approximate$/i, "").trim();
    }
    return "";
  }

  function sectionLines(lines, headingPattern, stopPattern) {
    const start = lines.findIndex((line) => headingPattern.test(line));
    if (start < 0) return [];
    const section = [];
    for (const line of lines.slice(start + 1)) {
      if (stopPattern.test(line)) break;
      section.push(line);
    }
    return section;
  }

  function splitRoomOptions(description) {
    const lines = (description || "").split(/\n+/).map(clean).filter(Boolean);
    const headings = [];
    for (let index = 0; index < lines.length; index += 1) {
      const match = lines[index].match(/^(?:room|bedroom)\s+([a-z]|\d+)\s*(?:[:\-–—]\s*(.*))?$/i);
      const master = lines[index].match(/^(master|primary)\s+(?:bed)?room\s*(?:[:\-–—]\s*(.*))?$/i);
      if (match) headings.push({ index, name: `Room ${match[1].toUpperCase()}`, suffix: match[2] || "" });
      else if (master) headings.push({ index, name: `${master[1][0].toUpperCase()}${master[1].slice(1).toLowerCase()} bedroom`, suffix: master[2] || "" });
    }
    if (headings.length < 2) return [];
    const shared = lines.slice(0, headings[0].index).join(" ");
    return headings.slice(0, 6).map((heading, optionIndex) => {
      const end = headings[optionIndex + 1]?.index ?? lines.length;
      const detail = [heading.suffix, ...lines.slice(heading.index + 1, end)].filter(Boolean).join(" ");
      const roomText = [shared, detail].filter(Boolean).join(" ");
      const priceMatch = detail.match(/(?:CA\$|C\$|CAD\s*|\$)\s?([\d][\d,]*(?:\.\d{1,2})?)/i);
      return {
        name: heading.name,
        description: roomText.slice(0, 12000),
        price: priceMatch ? Number(priceMatch[1].replaceAll(",", "")) : null,
        bedrooms: roomCount(detail, "bedrooms"),
        bathrooms: roomCount(detail, "bathrooms")
      };
    });
  }

  function profileFacts(text) {
    const facts = [];
    const joined = text.match(/\bJoined Facebook in (\d{4})\b/i);
    if (joined) facts.push(`Public profile page shows it joined Facebook in ${joined[1]}.`);
    const reviewLine = text.split(/\n+/).map(clean).find((line) => /(?:★{1,5}|\d+(?:\.\d+)?\s*stars?)/i.test(line) && /\(\d+\)/.test(line));
    if (reviewLine) facts.push(`Public profile page displays this review summary: ${reviewLine.slice(0, 100)}.`);
    return facts;
  }

  function roomCount(text, kind) {
    const pattern = kind === "bedrooms"
      ? /\b(\d+(?:\.\d+)?)[ \t]*[- ]?[ \t]*(?:bed(?:room)?s?|br)\b/i
      : /\b(\d+(?:\.\d+)?)[ \t]*[- ]?[ \t]*(?:bath(?:room)?s?|ba)\b/i;
    const match = text.match(pattern);
    if (match) return Number(match[1]);
    return kind === "bedrooms" && /\bstudio\b/i.test(text) ? 0 : null;
  }

  function pageKind() {
    const craigslist = /^(?:[^.]+\.)*craigslist\.org$/i.test(location.hostname);
    const facebook = /^(?:www\.)?facebook\.com$/i.test(location.hostname);
    const furnishedFinder = /^(?:www\.)?furnishedfinder\.com$/i.test(location.hostname);
    if (craigslist) {
      return document.querySelector("#postingbody") && (document.querySelector("#titletextonly") || document.querySelector("h1"))
        ? "detail"
        : "search";
    }
    if (facebook && location.pathname.startsWith("/marketplace/")) {
      return /^\/marketplace\/item\/\d+(?:\/|$)/.test(location.pathname) ? "detail" : "search";
    }
    if (furnishedFinder) {
      return /^\/property\/[\w-]+\/?$/.test(location.pathname) ? "detail" : "search";
    }
    return "unsupported";
  }

  function isPlaceholderTitle(value) {
    return /^(?:chats?|messages?|marketplace|search results?|facebook|craigslist|rental listing|listing details?)$/i.test(clean(value));
  }

  function isLegacySearchEntry(check = {}) {
    if (check.listing_id) return false;
    const title = clean(check.title || check.listing?.title || "");
    const looksLikeSearch = /^(?:houses?|apartments?|rooms?|condos?|homes?)\s+(?:for\s+)?rent(?:als?)?$/i.test(title);
    const snapshot = check.listing || {};
    return looksLikeSearch
      && snapshot.price == null
      && snapshot.bedrooms == null
      && snapshot.bathrooms == null
      && !clean(snapshot.location_text);
  }

  function facebookListingHeading() {
    const main = document.querySelector('[role="main"]');
    const nodes = [...document.querySelectorAll("h1, h2, h3, [role='heading']")];
    const candidates = nodes.map((node) => ({ node, text: clean(node.innerText || node.textContent) }))
      .filter(({ text }) => text && text.length <= 180 && !isPlaceholderTitle(text));
    const rentalTitle = /\b(?:rent|rental|room|bed|bath|apartment|house|suite|condo|studio|basement|furnished|duplex|townhouse)\b/i;
    candidates.sort((a, b) => {
      const score = ({ node, text }) =>
        (rentalTitle.test(text) ? 10 : 0)
        + (node.tagName === "H1" ? 3 : 0)
        + (node.closest('[role="dialog"]') ? 2 : 0)
        + (node.closest('[role="main"]') ? 1 : 0)
        - (text.length > 100 ? 3 : 0);
      return score(b) - score(a);
    });
    if (candidates[0]) return candidates[0].node;

    // Some Marketplace layouts expose the listing title only in the document
    // title or Open Graph metadata, while a Messenger heading says “Chats”.
    const titleCandidates = [
      document.querySelector("meta[property='og:title']")?.getAttribute("content"),
      document.title.replace(/\s*[|·–-]\s*Facebook\s*$/i, "").replace(/^Marketplace\s*[|·–-]\s*/i, "")
    ].map(clean).filter((text) => text && !isPlaceholderTitle(text) && text.length <= 180);
    const title = titleCandidates.find((text) => rentalTitle.test(text));
    if (!title) return null;
    const matchingHeading = candidates.find(({ text }) => text === title);
    return matchingHeading?.node || null;
  }

  function facebookListingTitle() {
    const heading = facebookListingHeading();
    if (heading) return clean(heading.innerText || heading.textContent);
    const candidates = [
      document.querySelector("meta[property='og:title']")?.getAttribute("content"),
      document.title.replace(/\s*[|·–-]\s*Facebook\s*$/i, "").replace(/^Marketplace\s*[|·–-]\s*/i, "")
    ].map(clean).filter((text) => text && !isPlaceholderTitle(text) && text.length <= 180);
    return candidates.find((text) => /\b(?:rent|rental|room|bed|bath|apartment|house|suite|condo|studio|basement|furnished|duplex|townhouse)\b/i.test(text)) || "";
  }

  function facebookListingRoot() {
    const main = document.querySelector('[role="main"]') || document.querySelector("main") || document.body;
    const titleHeading = facebookListingHeading();
    const descriptionHeading = [...document.querySelectorAll("h1, h2, h3, [role='heading']")]
      .find((node) => /^description$/i.test(clean(node.innerText || node.textContent)));
    if (!titleHeading && !facebookListingTitle()) return null;

    // Marketplace moved the listing details outside its main landmark in some
    // layouts. On an explicit /marketplace/item/<id> route, the page main is
    // the listing context; card/search routes never reach this extractor.
    const dialog = titleHeading?.closest('[role="dialog"]');
    if (dialog && /\bdescription\b/i.test(dialog.innerText || "")) return dialog;
    const heading = titleHeading || descriptionHeading;
    for (let node = heading?.parentElement; node && node !== main; node = node.parentElement) {
      const text = clean(node.innerText);
      const hasDescription = /\bdescription\b/i.test(text);
      const hasPrice = /(?:CA\$|C\$|CAD\s*|\$)\s?[\d][\d,]*/i.test(text);
      const includesOtherContent = /\b(?:related searches|today's picks|suggested for you)\b/i.test(text);
      if (hasDescription && hasPrice && !includesOtherContent && text.length < 12_000) return node;
    }
    return main;
  }

  function extractListing() {
    const craigslist = location.hostname.endsWith("craigslist.org");
    const furnishedFinder = /^(?:www\.)?furnishedfinder\.com$/i.test(location.hostname);
    if (pageKind() !== "detail") throw new Error("This is a search page, not an individual rental listing.");
    const listingRoot = craigslist ? null : furnishedFinder
      ? document.querySelector("#main-content") || document.querySelector("main") || document.body
      : facebookListingRoot();
    if (!craigslist && !listingRoot) throw new Error("Could not identify the listing details on this page.");
    const lines = textLines(craigslist ? document.querySelector("#housing") || document.body : listingRoot);
    const mainText = (document.querySelector('[role="main"]') || document.body)?.innerText || "";
    const title = craigslist ? firstText(["#titletextonly", "h1"]) : furnishedFinder
      ? firstText(["main h1", "h1", "meta[property='og:title']", "title"])
        .replace(/\s*[|·–-]\s*Furnished Finder\s*$/i, "")
      : facebookListingTitle();
    const facebookDescriptionLines = sectionLines(lines, /^description$/i, /^(?:getting around|seller information|seller details|more from this seller)$/i);
    const furnishedDescriptionLines = sectionLines(lines, /^(?:overview|about this property|description)$/i, /^(?:amenities|availability|reviews|landlord|location)$/i);
    const description = craigslist
      ? (document.querySelector("#postingbody")?.innerText || firstText(["[itemprop='description']"]))
      : furnishedFinder
        ? furnishedDescriptionLines.join("\n") || listingRoot?.innerText || ""
      : facebookDescriptionLines.length
        ? facebookDescriptionLines.join("\n")
        : listingRoot?.innerText || "";
    const priceText = craigslist
      ? firstText([".price", "[itemprop='price']"])
      : clean(listingRoot?.innerText);
    const priceMatch = priceText.match(/(?:CA\$|C\$|CAD\s*|\$)\s?([\d][\d,]*(?:\.\d{1,2})?)/i)
      || title.match(/(?:CA\$|C\$|CAD\s*|\$)\s?([\d][\d,]*(?:\.\d{1,2})?)/i);
    const price = priceMatch ? Number(priceMatch[1].replaceAll(",", "")) : null;
    const bodyText = clean(description).slice(0, 12000);
    const titleText = clean(title || document.title).replace(/\s*[|·–-]\s*Furnished Finder\s*$/i, "").slice(0, 300);
    if (!craigslist && isPlaceholderTitle(titleText)) {
      throw new Error("Could not identify this listing’s title. Reload the listing and try again.");
    }
    // Only parse room counts from this listing's title and description. Search
    // filters and nearby page text can contain unrelated numbers (e.g. 306 sq ft).
    const factsText = `${titleText}\n${bodyText}\n${furnishedFinder || craigslist ? clean((craigslist ? document.querySelector("#housing") : listingRoot)?.innerText) : ""}`;
    const bedrooms = roomCount(factsText, "bedrooms");
    const bathrooms = roomCount(factsText, "bathrooms");
    const rooms = splitRoomOptions(description);
    const pageImages = craigslist
      ? [...document.images]
      : furnishedFinder
        ? (() => {
            const propertyId = location.pathname.match(/^\/property\/([^/]+)/)?.[1];
            const images = [...(listingRoot?.querySelectorAll("img") || [])];
            const propertyImages = images.filter((img) => (img.alt || "").toLowerCase().includes(`property ${propertyId}`.toLowerCase()));
            return propertyImages.length ? propertyImages : images.filter((img) => /property photo/i.test(img.alt || ""));
          })()
        : [...new Set([
          ...listingRoot?.querySelectorAll('button[aria-label*="photo" i] img, [role="button"][aria-label*="photo" i] img') || [],
          ...listingRoot?.querySelectorAll("img") || []
        ])];
    const imageUrls = [...new Set(pageImages
      .filter((img) => img.naturalWidth >= 220 && img.naturalHeight >= 140)
      .filter((img) => !/profile|avatar|seller|emoji|map/i.test(img.alt || ""))
      .map((img) => img.currentSrc || img.src)
      .filter((src) => /^https?:/i.test(src)))]
      .filter((src) => !/profile|avatar|emoji|static_map|pixel|tracking/i.test(src))
      .slice(0, 8);
    let locationText = "";
    let address = "";
    let latitude = null;
    let longitude = null;
    if (craigslist) {
      locationText = firstText([".mapaddress", "[itemprop='address']", ".postingtitletext small"]);
      address = firstText(["#mapaddress", "[itemprop='streetAddress']", ".mapaddress"]);
      const map = document.querySelector("#map[data-latitude][data-longitude], [data-latitude][data-longitude], [data-lat][data-lon]");
      const latValue = map?.dataset.latitude || map?.dataset.lat;
      const lonValue = map?.dataset.longitude || map?.dataset.lon;
      if (latValue && lonValue) {
        const parsedLat = Number(latValue);
        const parsedLon = Number(lonValue);
        if (Number.isFinite(parsedLat) && Number.isFinite(parsedLon)) {
          latitude = parsedLat;
          longitude = parsedLon;
        }
      }
    } else if (furnishedFinder) {
      const cityMatch = lines.map((line) => line.match(/\bin\s+([A-Z][A-Za-z .'-]+,\s*[A-Z]{2})\b/i)
        || line.match(/^([A-Z][A-Za-z .'-]+,\s*[A-Z]{2})$/)).find(Boolean);
      locationText = valueAfterLabel(lines, /^(?:location|city)(?:\s*[:\-–·]\s*|$)/i)
        || cityMatch?.[1]
        || "";
      address = valueAfterLabel(lines, /^(?:street\s+)?address(?:\s*[:\-–·]\s*|$)/i);
    } else {
      locationText = valueAfterLabel(lines, /^(?:rental\s+)?location(?:\s*[:\-–·]\s*|$)/i);
      address = valueAfterLabel(lines, /^(?:street\s+)?address(?:\s*[:\-–·]\s*|$)/i);
      const map = listingRoot?.querySelector("[data-latitude][data-longitude], [data-lat][data-lon]");
      const latValue = map?.dataset.latitude || map?.dataset.lat;
      const lonValue = map?.dataset.longitude || map?.dataset.lon;
      if (latValue && lonValue) {
        const parsedLat = Number(latValue);
        const parsedLon = Number(lonValue);
        if (Number.isFinite(parsedLat) && Number.isFinite(parsedLon)) {
          latitude = parsedLat;
          longitude = parsedLon;
        }
      }
    }
    const pageContext = clean((craigslist ? document.querySelector("#housing") : furnishedFinder ? listingRoot : null)?.innerText);
    const fullText = `${titleText} ${bodyText} ${pageContext}`;
    const pricePeriod = /\b(?:per|a)\s*(?:week|wk)\b|\/\s*week|\bweekly\b/i.test(fullText)
      ? "week"
      : /\b(?:per|a)\s*day\b|\/\s*day/i.test(fullText)
        ? "day"
        : /\b(?:per|a)\s*night\b|\/\s*night/i.test(fullText)
          ? "night"
          : /\b(?:per|a)\s*month\b|\/\s*month|\bmonthly\b/i.test(fullText) || !craigslist
            ? "month"
            : "unknown";
    const currency = furnishedFinder && (/(?:\bUSD\b|US\$|United States|,\s*(?:CA|NY|TX|FL|WA|OR|AZ|NV)\b)/i.test(`${locationText} ${fullText}`))
      ? "USD"
      : "CAD";
    return {
      title: titleText,
      description: bodyText,
      bedrooms,
      bathrooms,
      address: address.slice(0, 500) || null,
      price,
      currency,
      price_period: pricePeriod,
      location_text: locationText.slice(0, 300),
      latitude,
      longitude,
      image_urls: imageUrls,
      source_url: location.href,
      rooms,
      profile_facts: craigslist ? [] : profileFacts(mainText),
      listing_age: lines.find((line) => /^listed\s+/i.test(line))?.slice(0, 100) || null,
      availability_text: (bodyText.match(/\bavailable\b.{0,160}/i) || [])[0] || null
    };
  }

  function cardAnchors() {
    if (/^(?:www\.)?facebook\.com$/i.test(location.hostname)) {
      return [...document.querySelectorAll('a[href*="/marketplace/item/"]')]
        .filter((anchor) => /\/marketplace\/item\/\d+\/?(?:[?#]|$)/.test(anchor.href));
    }
    if (/^(?:[^.]+\.)*craigslist\.org$/i.test(location.hostname)) {
      return [...document.querySelectorAll('a[href*="/d/"], a[href*="/view/d/"]')]
        .filter((anchor) => {
          try {
            const path = new URL(anchor.href, location.href).pathname;
            return /^\/view\/d\/[^/]+\/[^/]+\/?$/.test(path) || /\/d\/[^/]+\/\d+\.html$/.test(path);
          } catch (_) { return false; }
        });
    }
    if (/^(?:www\.)?furnishedfinder\.com$/i.test(location.hostname)) {
      return [...document.querySelectorAll('a[href*="/property/"]')]
        .filter((anchor) => {
          try { return /^\/property\/[\w-]+\/?$/.test(new URL(anchor.href, location.href).pathname); }
          catch (_) { return false; }
        });
    }
    return [];
  }

  function isRentalSearchPage() {
    if (/^(?:[^.]+\.)*craigslist\.org$/i.test(location.hostname)) {
      const route = `${location.pathname} ${location.search} ${location.hash}`;
      return /(?:\/search\/(?:apa|roo|sub|vac)|hub=[^&#]*(?:rent|housing|room))/i.test(route)
        || cardAnchors().length > 0
        || /apartments?\s*\/\s*housing for rent|rooms?\s*\/\s*shared/i.test((document.body?.innerText || "").slice(0, 2_500));
    }
    if (/^(?:www\.)?furnishedfinder\.com$/i.test(location.hostname)) {
      return location.pathname.startsWith("/housing/") || cardAnchors().length > 0;
    }
    const query = new URLSearchParams(location.search).get("query") || "";
    const searchInput = [...document.querySelectorAll("input")].map((input) => input.value || "").join(" ");
    const heading = document.querySelector("h1")?.innerText || "";
    return /\b(?:rent|rental|rentals|apartment|room for rent|house for rent|housing)\b/i.test(`${query} ${searchInput} ${heading}`);
  }

  function listingCard(anchor) {
    let node = anchor;
    let fallback = anchor;
    let fallbackChosen = false;
    for (let depth = 0; node && node !== document.body && depth < 8; depth += 1, node = node.parentElement) {
      const text = clean(node.innerText);
      if (text.length > 1_000) break;
      if (node.matches("li, article, [role='article']")) return node;
      if (text.length >= 8 && text.length <= 600 && /(?:CA\$|C\$|CAD\s*|\$)\s?\d/i.test(text)) return node;
      if (!fallbackChosen && depth > 0 && text.length >= 8 && text.length <= 450 && node.querySelector("img")) {
        fallback = node;
        fallbackChosen = true;
      }
    }
    return fallback;
  }

  function quickCardData(anchor, index) {
    const card = listingCard(anchor);
    const rawText = card.innerText || anchor.innerText || anchor.getAttribute("aria-label") || "";
    const lines = rawText.split(/\n+/).map(clean).filter(Boolean);
    const pricePattern = /^(?:CA\$|C\$|CAD\s*|\$)\s?[\d,]+(?:\.\d{1,2})?$/i;
    const metaPattern = /(?:\b\d+\s*(?:min|minutes?|hr|hours?|days?|weeks?|months?)\s+ago\b|\b\d+\s*(?:sq\.?\s*ft|ft²|ft2)\b|·\s*\d+\s*(?:br|bed)\b)/i;
    const title = lines.find((line) => !pricePattern.test(line) && !metaPattern.test(line) && !/^sponsored$/i.test(line))
      || clean(anchor.getAttribute("aria-label"))
      || card.querySelector("img[alt]")?.alt
      || "Rental listing";
    const description = lines
      .filter((line) => line !== title && !pricePattern.test(line) && !metaPattern.test(line))
      .join(" ")
      .slice(0, 1_200);
    const image = [...card.querySelectorAll("img")].find((img) => !/profile|avatar|seller|emoji|map|logo/i.test(img.alt || ""));
    const key = new URL(anchor.href, location.href);
    key.hash = "";
    key.search = "";
    return {
      key: key.href,
      card,
      listing: { id: String(index), title: title.slice(0, 300), description, photo_available: Boolean(image) },
    };
  }

  function addCardBadge(card, initialText = "RedFlag · checking") {
    if (!document.getElementById("redflag-card-styles")) {
      const style = document.createElement("style");
      style.id = "redflag-card-styles";
      style.textContent = `
        .redflag-card-badge { position:absolute; z-index:2147483000; top:8px; right:8px; max-width:calc(100% - 16px); padding:6px 9px; border:1px solid #4b505a; border-radius:999px; background:#171a20ed; color:#f2f3f5; box-shadow:0 5px 18px #0006; font:700 11px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; letter-spacing:.015em; white-space:normal; pointer-events:none; }
        .redflag-card-badge[data-status="low"] { border-color:#54c887; color:#72dda0; }
        .redflag-card-badge[data-status="careful"] { border-color:#f1a64b; color:#ffc16e; }
        .redflag-card-badge[data-status="possible"] { border-color:#ef6868; color:#ff8787; }
        .redflag-card-badge[data-status="unavailable"] { color:#b4b7c0; }
      `;
      (document.head || document.documentElement).append(style);
    }
    if (card.querySelector(":scope > .redflag-card-badge")) return card.querySelector(":scope > .redflag-card-badge");
    if (getComputedStyle(card).position === "static") card.style.position = "relative";
    const badge = document.createElement("span");
    badge.className = "redflag-card-badge";
    badge.dataset.status = "pending";
    badge.setAttribute("role", "status");
    badge.textContent = initialText;
    card.append(badge);
    return badge;
  }

  function setBadge(badge, result) {
    const score = Math.max(0, Math.min(100, Math.round(Number(result.risk_score) || 0)));
    const status = score >= 60 ? "possible" : score >= 30 ? "careful" : "low";
    badge.dataset.status = status;
    badge.textContent = score === 0 ? "0/100 · No warning text" : `${score}/100 · ${result.risk_level}`;
    badge.title = "Quick scan of the visible card text only. Open the listing for its full check. This is not a probability.";
  }

  function mountDetailOverlay() {
    if (overlayHost?.isConnected) overlayHost.remove();
    overlayHost = document.createElement("div");
    overlayHost.id = "redflag-detail-host";
    const shadow = overlayHost.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        .launcher { position: fixed; z-index: 2147483646; right: 18px; bottom: 18px; display: flex; align-items: center; gap: 8px; max-width: calc(100vw - 36px); padding: 10px 14px; border: 1px solid #464b56; border-radius: 999px; background: #171a20; color: #f4f4f5; box-shadow: 0 10px 32px #0008; font: 700 13px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; cursor: pointer; transition: transform .16s ease, border-color .16s ease; }
        .launcher:hover { transform: translateY(-2px); border-color: #747985; }
        .dot { width: 8px; height: 8px; border-radius: 50%; background: #b6bac4; }
        .launcher[data-status="low"] .dot { background: #54c887; }
        .launcher[data-status="careful"] .dot { background: #f1a64b; }
        .launcher[data-status="possible"] .dot { background: #ef6868; }
        .panel { position: fixed; z-index: 2147483647; right: 18px; bottom: 68px; width: min(360px, calc(100vw - 36px)); max-height: min(72vh, 620px); overflow: auto; padding: 17px; border: 1px solid #3e434d; border-radius: 20px; background: #15181e; color: #f4f4f5; box-shadow: 0 20px 56px #000a; font: 14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
        .hidden { display: none; }
        .header { display:flex; align-items:center; gap:10px; margin-bottom:14px; }
        .brand { display:grid; place-items:center; width:30px; height:30px; border:1px solid #464b56; border-radius:10px; background:#242830; font-weight:800; }
        .heading { flex:1; font-size:14px; font-weight:750; }
        .close { width:30px; height:30px; border:1px solid #3e434d; border-radius:9px; background:#20232a; color:#bbbfc8; font-size:18px; cursor:pointer; }
        .score-card { padding:14px; border:1px solid #353a44; border-radius:15px; background:#1b1f26; }
        .score-card[data-status="unavailable"] .score, .score-card[data-status="unavailable"] .label { color:#b4b7c0; }
        .risk-line { display:flex; align-items:center; flex-wrap:wrap; gap:9px; }
        .score { font-size:30px; font-weight:800; letter-spacing:-.05em; font-variant-numeric:tabular-nums; }
        .label { padding:4px 8px; border:1px solid currentColor; border-radius:999px; font-size:11px; font-weight:800; letter-spacing:.035em; }
        [data-status="low"] .score, [data-status="low"] .label { color:#54c887; }
        [data-status="careful"] .score, [data-status="careful"] .label { color:#f1a64b; }
        [data-status="possible"] .score, [data-status="possible"] .label { color:#ef6868; }
        .summary { display:none; margin:6px 0 0; color:#b4b7c0; font-size:12px; }
        .score-card[data-status="pending"] .summary, .score-card[data-status="unavailable"] .summary { display:block; }
        .toggle { margin-top:12px; padding:0; border:0; background:none; color:#eee; font:inherit; font-size:12px; font-weight:700; line-height:1.4; text-decoration:underline; text-underline-offset:3px; cursor:pointer; }
        .retry { display:block; width:100%; margin-top:12px; padding:10px 12px; border:1px solid #3e434d; border-radius:11px; background:#252932; color:#f4f4f5; font:700 13px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; cursor:pointer; }
        .retry:hover { border-color:#747985; background:#303540; }
        .details { margin-top:13px; padding-top:12px; border-top:1px solid #343842; }
        .details h3 { margin:13px 0 6px; font-size:13px; }
        .details h3:first-child { margin-top:0; }
        .details p, .details li { color:#b4b7c0; font-size:12px; }
        .details ul { display:grid; gap:9px; margin:0; padding-left:17px; }
        .evidence { display:block; margin-top:4px; color:#e2e3e7; }
        .note { display:none; margin:13px 0 0; color:#858a95; font-size:11px; }
        .details .note { display:block; }
        @media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition-duration:.01ms !important; } }
      </style>
      <button class="launcher" type="button" aria-expanded="false"><span class="dot"></span><span>RedFlag · Checking listing…</span></button>
      <section class="panel hidden" aria-label="RedFlag listing check">
        <div class="header"><span class="brand">R</span><span class="heading">RedFlag · Listing check</span><button class="close" type="button" aria-label="Close">×</button></div>
        <div class="score-card" data-status="pending"><div class="risk-line"><strong class="score">—</strong><span class="label">CHECKING</span></div><p class="summary">Checking this listing with your configured service.</p></div>
        <button class="toggle hidden" type="button" aria-expanded="false">See details</button>
        <button class="retry hidden" type="button">Try again</button>
        <div class="details hidden"></div>
        <p class="note">A screening aid, not proof of fraud. Verify the unit and who can rent it.</p>
      </section>`;
    document.documentElement.append(overlayHost);
    const launcher = shadow.querySelector(".launcher");
    const panel = shadow.querySelector(".panel");
    const close = shadow.querySelector(".close");
    const toggle = shadow.querySelector(".toggle");
    const retry = shadow.querySelector(".retry");
    launcher.addEventListener("click", () => {
      const opening = panel.classList.contains("hidden");
      panel.classList.toggle("hidden", !opening);
      launcher.setAttribute("aria-expanded", String(opening));
    });
    close.addEventListener("click", () => {
      panel.classList.add("hidden");
      launcher.setAttribute("aria-expanded", "false");
    });
    toggle.addEventListener("click", () => {
      const details = shadow.querySelector(".details");
      const opening = details.classList.contains("hidden");
      details.classList.toggle("hidden", !opening);
      toggle.textContent = opening ? "See less" : "See details";
      toggle.setAttribute("aria-expanded", String(opening));
    });
    retry.addEventListener("click", () => {
      retry.classList.add("hidden");
      checkOpenedListing().catch(renderDetailError);
    });
    return { shadow, launcher, panel };
  }

  function renderDetailResult(overlay, listing, analysis) {
    const score = Math.max(0, Math.min(100, Math.round(Number(analysis.risk_score) || 0)));
    const status = score >= 60 ? "possible" : score >= 30 ? "careful" : "low";
    const card = overlay.shadow.querySelector(".score-card");
    card.dataset.status = status;
    overlay.shadow.querySelector(".score").textContent = `${score} / 100`;
    overlay.shadow.querySelector(".label").textContent = analysis.risk_level;
    overlay.shadow.querySelector(".summary").textContent = analysis.summary || "Listing check complete.";
    const details = overlay.shadow.querySelector(".details");
    details.replaceChildren();
    const addText = (tag, text, parent = details) => {
      const element = document.createElement(tag);
      element.textContent = text;
      parent.append(element);
      return element;
    };
    addText("h3", "Why this score");
    if (analysis.summary) addText("p", analysis.summary);
    if (analysis.signals?.length) {
      const list = document.createElement("ul");
      analysis.signals.forEach((signal) => {
        const item = document.createElement("li");
        const strong = document.createElement("strong");
        strong.textContent = signal.title;
        item.append(strong);
        if (signal.detail) addText("p", signal.detail, item);
        if (signal.evidence) addText("span", `Evidence from ${signal.evidence_source || "listing"}: “${signal.evidence}”`, item).className = "evidence";
        list.append(item);
      });
      details.append(list);
    } else {
      addText("p", "No specific warning signs were found in the details RedFlag could read.");
    }
    if (analysis.room_results?.length > 1) {
      addText("p", `This page describes ${analysis.room_results.length} room options. See the room breakdown in the RedFlag extension popup.`);
    }
    addText("h3", "Listing details · unverified");
    const facts = [
      listing.price == null ? "Asking price was not visible on the page." : `Asking price shown: ${listing.currency || "CAD"} ${listing.price}${listing.price_period ? ` / ${listing.price_period}` : ""}.`,
      listing.bedrooms == null ? "Bedroom count was not visible on the page." : `Bedrooms shown: ${listing.bedrooms}.`,
      listing.bathrooms == null ? "Bathroom count was not visible on the page." : `Bathrooms shown: ${listing.bathrooms}.`,
      listing.location_text ? `Location shown: ${listing.location_text}.` : "A location was not visible on the page.",
    ];
    facts.forEach((fact) => addText("p", fact));
    addText("p", analysis.price_comparison_available
      ? `Price and location compared with ${analysis.baseline?.peer_count || 0} nearby listings in RedFlag’s local history.`
      : analysis.baseline?.message || "No nearby price comparison was available.");
    addText("h3", "Furnish Finder");
    addText("p", analysis.furnish_finder?.summary || "Photo furnishing estimate unavailable.");
    if (analysis.furnish_finder?.likely_visible_items?.length) addText("p", `Likely visible: ${analysis.furnish_finder.likely_visible_items.join(", ")}.`);
    addText("p", analysis.photos_processed
      ? `${analysis.photos_processed} listing photo${analysis.photos_processed === 1 ? "" : "s"} processed.`
      : "No listing photos could be processed.");
    addText("p", "Profile history, ownership, and rental authority have not been independently verified.");
    addText("p", `Listing checked: ${listing.title || "Rental listing"}.`);
    addText("p", "This score is a screening aid, not a probability or proof of fraud. Verify the unit and who can rent it.").className = "note";
    const toggle = overlay.shadow.querySelector(".toggle");
    toggle.classList.remove("hidden");
    overlay.launcher.dataset.status = status;
    overlay.launcher.querySelector("span:last-child").textContent = `RedFlag · ${score}/100 ${analysis.risk_level}`;
  }

  function renderDetailError(error) {
    const overlay = overlayHost?.isConnected
      ? { shadow: overlayHost.shadowRoot, launcher: overlayHost.shadowRoot.querySelector(".launcher") }
      : mountDetailOverlay();
    const card = overlay.shadow.querySelector(".score-card");
    card.dataset.status = "unavailable";
    overlay.shadow.querySelector(".score").textContent = "—";
    overlay.shadow.querySelector(".label").textContent = "CHECK FAILED";
    overlay.shadow.querySelector(".summary").textContent = error?.message || "Could not complete this listing check. Try again.";
    overlay.shadow.querySelector(".toggle").classList.add("hidden");
    overlay.shadow.querySelector(".details").classList.add("hidden");
    overlay.shadow.querySelector(".retry").classList.remove("hidden");
    overlay.launcher.dataset.status = "unavailable";
    overlay.launcher.querySelector("span:last-child").textContent = "RedFlag · check failed";
    overlay.shadow.querySelector(".panel").classList.remove("hidden");
    overlay.launcher.setAttribute("aria-expanded", "true");
  }

  async function checkOpenedListing() {
    const overlay = mountDetailOverlay();
    let listing;
    let lastError;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        listing = extractListing();
        break;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
    if (!listing) throw lastError || new Error("Listing details did not load.");
    const response = await chrome.runtime.sendMessage({ type: "REDFLAG_FULL_ANALYSIS", listing });
    if (!response?.ok) throw new Error(response?.error || "Could not reach the analysis service.");
    renderDetailResult(overlay, listing, response.result);
    await saveRecentCheck(listing, response.result);
  }

  function listingIdentity(listing) {
    try {
      const url = new URL(listing.source_url);
      const facebookId = url.pathname.match(/\/marketplace\/item\/(\d+)/)?.[1];
      const craigslistId = url.pathname.match(/\/view\/d\/[^/]+\/([^/]+)\/?$/)?.[1]
        || url.pathname.match(/\/(\d+)\.html$/)?.[1];
      return facebookId ? `facebook:${facebookId}` : craigslistId ? `craigslist:${craigslistId}` : `${url.hostname}${url.pathname}`;
    } catch (_) {
      return clean(listing.title).toLowerCase();
    }
  }

  async function saveRecentCheck(listing, analysis) {
    const title = clean(listing.title);
    if (!title || isPlaceholderTitle(title)) return;
    const identity = listingIdentity(listing);
    const stored = await chrome.storage.local.get("recentChecks");
    const recentChecks = (Array.isArray(stored.recentChecks) ? stored.recentChecks : [])
      .filter((check) => !isPlaceholderTitle(check?.title || check?.listing?.title))
      .filter((check) => !isLegacySearchEntry(check))
      .filter((check) => check?.listing_id !== identity);
    const overall = analysis.room_results?.length
      ? analysis.room_results.reduce((riskiest, room) => Number(room.risk_score) > Number(riskiest.risk_score) ? room : riskiest)
      : analysis;
    recentChecks.unshift({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      listing_id: identity,
      checked_at: Date.now(),
      title,
      listing: {
        title,
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
          name: room.name, price: room.price ?? null, bedrooms: room.bedrooms ?? null, bathrooms: room.bathrooms ?? null
        })) : []
      },
      analysis,
      overall
    });
    await chrome.storage.local.set({ recentChecks: recentChecks.slice(0, 5) });
  }

  async function scanSearchCards() {
    const candidates = [];
    const anchors = cardAnchors();
    anchors.forEach((anchor, index) => {
      const data = quickCardData(anchor, index);
      if (scoredCards.has(data.key)) return;
      const badge = addCardBadge(data.card);
      scoredCards.add(data.key);
      candidates.push({ ...data, badge });
    });
    for (let offset = 0; offset < candidates.length; offset += 20) {
      const batch = candidates.slice(offset, offset + 20);
      try {
        const response = await chrome.runtime.sendMessage({
          type: "REDFLAG_QUICK_SCORES",
          listings: batch.map(({ listing }) => listing),
        });
        if (!response?.ok) throw new Error(response?.error || "Analysis service unavailable.");
        const byId = new Map((response.result?.results || []).map((result) => [result.id, result]));
        batch.forEach(({ listing, badge, key }) => {
          const result = byId.get(listing.id);
          if (result) setBadge(badge, result);
          else badge.textContent = "RedFlag · unavailable";
          if (!result) badge.dataset.status = "unavailable";
        });
      } catch (error) {
        batch.forEach(({ badge, key }) => {
          badge.dataset.status = "unavailable";
          badge.textContent = "RedFlag · service unavailable";
          badge.title = error.message || "Start your configured RedFlag analysis service.";
          scoredCards.delete(key);
        });
        setTimeout(() => {
          if (pageKind() === "search") scanSearchCards().catch(() => {});
        }, 12_000);
      }
    }
  }

  function handlePage() {
    const kind = pageKind();
    const routeChanged = observedPageUrl !== location.href;
    const kindChanged = observedPageKind !== kind;
    if (!routeChanged && !kindChanged && kind !== "search") return;
    observedPageUrl = location.href;
    observedPageKind = kind;
    if (kind === "search") {
      if (overlayHost?.isConnected) overlayHost.remove();
      overlayHost = null;
      if (isRentalSearchPage()) scanSearchCards().catch(() => {});
    } else if (kind === "detail") {
      checkOpenedListing().catch(renderDetailError);
    }
  }

  let pageScanTimer = null;
  const pageObserver = new MutationObserver((mutations) => {
    const relevant = mutations.some((mutation) => {
      const target = mutation.target.nodeType === Node.ELEMENT_NODE ? mutation.target : mutation.target.parentElement;
      if (target?.closest?.("#redflag-detail-host, .redflag-card-badge") || target?.id === "redflag-card-styles") return false;
      return ![...mutation.addedNodes].every((node) => node.nodeType === Node.ELEMENT_NODE && (
        node.id === "redflag-detail-host" || node.id === "redflag-card-styles" || node.classList?.contains("redflag-card-badge")
      ));
    });
    if (!relevant) return;
    clearTimeout(pageScanTimer);
    pageScanTimer = setTimeout(handlePage, 700);
  });
  pageObserver.observe(document.documentElement, { childList: true, subtree: true });
  setInterval(() => {
    if (observedPageUrl !== location.href || observedPageKind !== pageKind()) handlePage();
  }, 1_500);
  setTimeout(handlePage, 500);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "RENTAL_SHIELD_EXTRACT") {
      try {
        sendResponse({ ok: true, listing: extractListing() });
      } catch (error) {
        sendResponse({ ok: false, kind: pageKind(), error: String(error) });
      }
      return true;
    }
  });
})();

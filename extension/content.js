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
    const lines = String(text || "").split(/\n+/).map(clean).filter(Boolean);
    const reviewCountPattern = /\(\s*\d+\s*(?:reviews?|ratings?)?\s*\)|\b\d+\s+(?:public\s+)?(?:reviews?|ratings?)\b/i;
    for (let index = 0; index < lines.length; index += 1) {
      const context = lines.slice(Math.max(0, index - 1), Math.min(lines.length, index + 2)).join(" · ");
      if (!reviewCountPattern.test(context) || !/review|rating|seller|[★⭐]/i.test(context)) continue;
      const explicitRating = context.match(/(?<![\d.])([0-5](?:\.\d+)?)\s*(?:\/\s*5|out\s+of\s+5|stars?|[★⭐])/i);
      const ratingContext = /\b(?:seller\s+)?ratings?\b/i.test(context) || /\breviews?\b/i.test(context);
      const plainDecimal = ratingContext ? context.match(/(?<![\d.])([0-5]\.\d+)(?![\d.])/) : null;
      const starRating = context.match(/([★☆⭐]{1,5})/);
      if (!explicitRating && !plainDecimal && !starRating) continue;
      facts.push(`Public seller review summary: ${context.slice(0, 150)}.`);
      break;
    }
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
          ...listingRoot?.querySelectorAll('button[aria-label*="photo" i] img, [role="button"][aria-label*="photo" i] img, img') || [],
          ...document.querySelector('[role="main"]')?.querySelectorAll('button[aria-label*="photo" i] img, [role="button"][aria-label*="photo" i] img, img') || []
        ])];
    const imageUrls = [...new Set(pageImages
      .filter((img) => img.naturalWidth >= 220 && img.naturalHeight >= 140)
      .filter((img) => {
        if (!/facebook/i.test(location.hostname)) return true;
        const rect = img.getBoundingClientRect();
        const src = img.currentSrc || img.src;
        try {
          const host = new URL(src).hostname;
          return rect.width >= 140 && rect.height >= 110
            && /(?:^|\.)(?:fbcdn\.net|fbsbx\.com|facebook\.com)$/i.test(host);
        } catch (_) {
          return false;
        }
      })
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
      profile_facts: craigslist ? [] : profileFacts(`${listingRoot?.innerText || ""}\n${mainText}`),
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

  function addCardBadge(card, initialText = "🛡️ Checking…") {
    if (!document.getElementById("redflag-card-styles")) {
      const style = document.createElement("style");
      style.id = "redflag-card-styles";
      style.textContent = `
        .redflag-card-badge { position:absolute; z-index:2147483000; top:8px; right:8px; max-width:calc(100% - 16px); padding:7px 10px; border:2px solid #cbd5e1; border-radius:999px; background:#fff; color:#12213a; box-shadow:0 5px 18px #0f172a33; font:800 12px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; letter-spacing:.015em; white-space:normal; pointer-events:none; }
        .redflag-card-badge[data-status="low"] { border-color:#86efac; background:#f0fdf4; color:#166534; }
        .redflag-card-badge[data-status="careful"] { border-color:#fcd34d; background:#fffbeb; color:#854d0e; }
        .redflag-card-badge[data-status="possible"] { border-color:#fca5a5; background:#fef2f2; color:#991b1b; }
        .redflag-card-badge[data-status="unavailable"] { border-color:#cbd5e1; background:#f8fafc; color:#475569; }
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
    const label = status === "possible" ? "Scam Possible" : status === "careful" ? "Be Careful" : "Low Risk";
    badge.dataset.status = status;
    badge.textContent = `${score >= 60 ? "🚩" : score >= 30 ? "⚠️" : "🛡️"} ${score}/100 · ${label}`;
    badge.title = "Quick scan of the visible card text only. Open the listing for its full check. This is not a probability.";
  }

  function shieldLogo(id, className) {
    return `<svg class="${className}" viewBox="0 0 128 128" role="img" aria-label="RedFlag shield"><defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7dd3fc"/><stop offset=".48" stop-color="#3b82f6"/><stop offset="1" stop-color="#1e40af"/></linearGradient></defs><path d="M64 7 111 25v33c0 28-18 49-47 62C35 107 17 86 17 58V25L64 7Z" fill="url(#${id})" stroke="#fff" stroke-opacity=".8" stroke-width="3"/><text x="64" y="76" fill="#fff" font-family="Arial,Helvetica,sans-serif" font-size="39" font-weight="800" letter-spacing="-3" text-anchor="middle">RF</text></svg>`;
  }

  // Traffic light shared by the launcher, the panel and the history list.
  const LIGHTS = {
    green: { status: "low", dot: "🟢", headline: "No red flags", label: "No warning signs found" },
    yellow: { status: "careful", dot: "🟡", headline: "Check first", label: "1 warning sign: check before paying" },
    red: { status: "possible", dot: "🔴", headline: "High risk", label: "2+ warning signs: high risk" },
  };

  const FLAG_NAMES = {
    model_deposit_demand: ["💵", "Deposit demand"],
    model_personal_info_request: ["🔐", "Personal info request"],
    model_etransfer_request: ["💳", "E-transfer request"],
    model_high_demand_claim: ["⏱️", "High-demand pressure"],
    model_foreign_payment: ["🌍", "Payment sent abroad"],
    model_price: ["🏷️", "Low price"],
    payment_before_viewing: ["💵", "Pay before viewing"],
    wire_or_irreversible_payment: ["💳", "Hard-to-reverse payment"],
    landlord_unavailable: ["👤", "Renter hard to reach"],
    verification_code: ["🔐", "Account-code request"],
    pressure_tactic: ["⏱️", "Urgent pressure"],
    review_checker: ["⭐", "Low public seller rating"],
  };

  function flagName(code) {
    const modelTree = /^model_tree_(\d+)$/.exec(code || "")?.[1];
    return FLAG_NAMES[code] || (modelTree ? ["🌳", `Model tree ${modelTree}`] : ["🚩", code || "Warning sign"]);
  }

  function parseTrees(analysis) {
    return (Array.isArray(analysis?.trees) ? analysis.trees : []).map((entry) => {
      const [voteText = "", code = "", ...ruleParts] = String(entry).split("|").map((part) => part.trim());
      return { vote: voteText.toLowerCase(), code, rule: ruleParts.join(" | ") };
    });
  }

  // Only the checks the listing failed. A low price is a red flag only
  // alongside another one, matching the backend's risk_light.
  function redFlags(analysis) {
    const failed = parseTrees(analysis).filter((row) => row.vote === "fake");
    return failed.some((row) => row.code !== "model_price") ? failed : [];
  }

  function lightOf(analysis) {
    const sent = analysis?.risk_light?.color;
    const count = redFlags(analysis).length;
    const color = LIGHTS[sent] ? sent : count === 0 ? "green" : count === 1 ? "yellow" : "red";
    return { color, ...LIGHTS[color], label: analysis?.risk_light?.label || LIGHTS[color].label };
  }

  function flagCountText(count) {
    return count === 0 ? "No red flags" : count === 1 ? "1 red flag" : `${count} red flags`;
  }

  function makeSemaphore(color) {
    const light = document.createElement("span");
    light.className = "semaphore";
    light.dataset.light = color;
    light.setAttribute("role", "img");
    light.setAttribute("aria-label", `Traffic light: ${color}`);
    ["red", "yellow", "green"].forEach((lamp) => {
      const bulb = document.createElement("i");
      bulb.className = `lamp-${lamp}`;
      light.append(bulb);
    });
    return light;
  }

  function flagNote(row, signals) {
    const signal = signals.get(row.code === "review_checker" ? "low_public_review_rating" : row.code);
    return [...new Set([row.rule, signal?.detail, signal?.evidence ? `Listing text: “${signal.evidence}”` : ""].filter(Boolean))].join(". ");
  }

  function renderRecentHistory(shadow) {
    const host = shadow?.querySelector(".history-list");
    if (!host) return;
    const heading = shadow.querySelector(".recent-history summary");
    host.replaceChildren();
    chrome.storage.local.get("recentChecks").then(({ recentChecks = [] }) => {
      if (!host.isConnected) return;
      const checks = (Array.isArray(recentChecks) ? recentChecks : [])
        .filter((check) => !isPlaceholderTitle(check?.title || check?.listing?.title))
        .filter((check) => !isLegacySearchEntry(check))
        .slice(0, 5);
      if (heading) heading.textContent = `🕘 Recent listings (${checks.length})`;
      if (!checks.length) {
        const empty = document.createElement("p");
        empty.className = "history-empty";
        empty.textContent = "Checked listings will appear here.";
        host.append(empty);
        return;
      }
      checks.forEach((check) => {
        const analysis = check.overall || check.analysis || {};
        const light = lightOf(analysis);
        const flags = redFlags(analysis);
        const entry = document.createElement("details");
        entry.className = "history-entry";
        const summary = document.createElement("summary");
        const title = document.createElement("span");
        title.className = "history-title";
        title.textContent = clean(check.title || check.listing?.title || "Rental listing");
        const status = document.createElement("span");
        status.className = "history-score";
        status.dataset.status = light.status;
        status.textContent = flags.length
          ? `${light.dot} ${light.headline} · ${flagCountText(flags.length)}`
          : `${light.dot} ${light.headline}`;
        summary.append(title, status);
        entry.append(summary);
        const date = document.createElement("time");
        date.className = "history-date";
        const checkedAt = Number(check.checked_at);
        if (Number.isFinite(checkedAt) && checkedAt > 0) {
          date.dateTime = new Date(checkedAt).toISOString();
          date.textContent = new Date(checkedAt).toLocaleString();
        } else {
          date.textContent = "Earlier check";
        }
        entry.append(date);
        if (flags.length) {
          const signals = new Map((analysis.signals || []).map((signal) => [signal.code, signal]));
          const flagList = document.createElement("ul");
          flagList.className = "history-factors";
          flags.forEach((row) => {
            const [icon, name] = flagName(row.code);
            const item = document.createElement("li");
            item.dataset.result = "flag";
            const glyph = document.createElement("span");
            glyph.setAttribute("aria-hidden", "true");
            glyph.textContent = icon;
            const copy = document.createElement("span");
            const heading = document.createElement("strong");
            heading.textContent = name;
            const note = document.createElement("small");
            note.textContent = flagNote(row, signals) || "Warning sign found";
            copy.append(heading, note);
            item.append(glyph, copy);
            flagList.append(item);
          });
          entry.append(flagList);
        } else {
          const none = document.createElement("p");
          none.className = "history-empty";
          none.textContent = "No red flags found.";
          entry.append(none);
        }
        host.append(entry);
      });
    }).catch(() => {
      if (!host.isConnected) return;
      const empty = document.createElement("p");
      empty.className = "history-empty";
      empty.textContent = "Recent checks are unavailable.";
      host.append(empty);
    });
  }

  function mountDetailOverlay() {
    if (overlayHost?.isConnected) overlayHost.remove();
    overlayHost = document.createElement("div");
    overlayHost.id = "redflag-detail-host";
    const shadow = overlayHost.attachShadow({ mode: "open" });
    const launcherLogo = shieldLogo("redflagLauncherLogo", "launcher-mark");
    const panelLogo = shieldLogo("redflagPanelLogo", "brand");
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        .launcher { position: fixed; z-index: 2147483646; right: 18px; bottom: 18px; display: flex; align-items: center; gap: 9px; max-width: calc(100vw - 36px); min-height: 52px; padding: 10px 17px; border: 2px solid #b8c4d1; border-radius: 999px; background: #fff; color: #111827; box-shadow: 0 8px 28px #0005; font: 800 16px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; cursor: pointer; transition: transform .16s ease, border-color .16s ease; }
        .launcher:hover { transform: translateY(-2px); border-color: #747985; }
        .launcher-mark { display:block; flex:0 0 auto; width:34px; height:34px; }
        .status-icon { display:grid; place-items:center; width:26px; height:26px; border-radius:50%; background:#e5e7eb; font-size:17px; }
        .launcher[data-status="low"] .status-icon { background:#d1fae5; color:#065f46; }
        .launcher[data-status="careful"] .status-icon { background:#fef3c7; color:#854d0e; }
        .launcher[data-status="possible"] .status-icon { background:#fee2e2; color:#991b1b; }
        .panel { position: fixed; z-index: 2147483647; right: 18px; bottom: 80px; width: min(410px, calc(100vw - 36px)); max-height: min(78vh, 720px); overflow: auto; padding: 18px; border: 2px solid #cbd5e1; border-radius: 20px; background: #fff; color: #111827; box-shadow: 0 20px 56px #0009; font: 16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
        .hidden { display: none; }
        .header { display:flex; align-items:center; gap:10px; margin-bottom:14px; }
        .brand { display:block; flex:0 0 auto; width:44px; height:44px; filter:drop-shadow(0 3px 6px #1d4ed833); }
        .heading { flex:1; font-size:18px; font-weight:800; }
        .close { width:44px; height:44px; border:2px solid #cbd5e1; border-radius:12px; background:#f8fafc; color:#111827; font-size:24px; cursor:pointer; }
        .score-card { padding:15px; border:2px solid #cbd5e1; border-radius:16px; background:#f8fafc; }
        .score-card[data-status="unavailable"] .score, .score-card[data-status="unavailable"] .label { color:#334155; }
        .risk-line { display:flex; align-items:center; gap:12px; }
        .score-icon { display:grid; place-items:center; flex:0 0 48px; width:48px; height:48px; border-radius:50%; background:#e2e8f0; font-size:27px; }
        .score-copy { display:grid; gap:1px; flex:1; }
        .eyebrow { color:#475569; font-size:12px; font-weight:800; letter-spacing:.06em; }
        .score { font-size:34px; font-weight:850; letter-spacing:-.04em; font-variant-numeric:tabular-nums; }
        .label { max-width:128px; padding:7px 9px; border:2px solid currentColor; border-radius:12px; font-size:13px; font-weight:850; line-height:1.2; text-align:center; }
        [data-status="low"] .score, [data-status="low"] .label { color:#166534; }
        [data-status="careful"] .score, [data-status="careful"] .label { color:#92400e; }
        [data-status="possible"] .score, [data-status="possible"] .label { color:#991b1b; }
        [data-status="low"] .score-icon { background:#dcfce7; color:#166534; }
        [data-status="careful"] .score-icon { background:#fef3c7; color:#92400e; }
        [data-status="possible"] .score-icon { background:#fee2e2; color:#991b1b; }
        .summary { margin:12px 0 0; color:#1f2937; font-size:16px; font-weight:650; }
        .quick-facts { display:grid; grid-template-columns:1fr; gap:8px; margin-top:12px; }
        .quick-fact { min-height:78px; padding:9px 7px; border:1px solid #cbd5e1; border-radius:12px; background:#fff; color:#1f2937; text-align:center; }
        .quick-icon { display:block; margin-bottom:3px; font-size:22px; }
        .quick-label { display:block; font-size:13px; font-weight:750; line-height:1.2; }
        .toggle { width:100%; min-height:48px; margin-top:12px; padding:10px 12px; border:2px solid #1d4ed8; border-radius:12px; background:linear-gradient(115deg,#eff6ff,#dbeafe); color:#1e3a8a; font:800 16px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; cursor:pointer; }
        .retry { display:block; width:100%; min-height:48px; margin-top:12px; padding:10px 12px; border:2px solid #2563eb; border-radius:12px; background:linear-gradient(110deg,#2563eb,#38bdf8); color:#fff; font:800 16px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; cursor:pointer; }
        .retry:hover { border-color:#1d4ed8; background:linear-gradient(110deg,#1d4ed8,#0ea5e9); }
        .panel.zero-score .retry, .panel.zero-score .eyebrow, .panel.zero-score .summary, .panel.zero-score .quick-facts { display:none; }
        .panel.zero-score .score-card { padding:12px 14px; }
        .panel.zero-score .risk-line { min-height:56px; }
        .panel.zero-score .header { margin-bottom:12px; }
        .panel.zero-score .toggle { margin-top:12px; }
        .launcher:focus-visible, .toggle:focus-visible, .close:focus-visible, .retry:focus-visible { outline:3px solid #1d4ed8; outline-offset:3px; }
        .details { margin-top:13px; padding-top:12px; border-top:2px solid #e2e8f0; }
        .details h3 { margin:14px 0 8px; font-size:17px; }
        .details h3:first-child { margin-top:0; }
        .details p, .details li { color:#334155; font-size:15px; }
        .factor-list { display:grid; gap:8px; margin:0; padding:0; list-style:none; }
        .factor { display:grid; grid-template-columns:34px 1fr auto; align-items:center; gap:9px; min-height:52px; padding:8px; border:1px solid #cbd5e1; border-radius:12px; background:#fff; }
        .factor-icon { display:grid; place-items:center; width:32px; height:32px; border-radius:50%; background:#dbeafe; font-size:18px; }
        .factor[data-result="flag"] { border-color:#fca5a5; background:#fff7f7; }
        .factor[data-result="flag"] .factor-icon { background:#fee2e2; }
        .factor[data-result="clear"] { border-color:#86efac; background:#f0fdf4; }
        .factor[data-result="clear"] .factor-icon { background:#dcfce7; }
        .factor[data-result="unknown"] { border-color:#cbd5e1; background:#f8fafc; }
        .factor-name { font-size:15px; font-weight:750; }
        .factor-result { font-size:13px; font-weight:800; }
        .factor[data-result="flag"] .factor-result { color:#991b1b; }
        .factor[data-result="clear"] .factor-result { color:#166534; }
        .factor[data-result="unknown"] .factor-result { color:#475569; }
        .factor-note { grid-column:2 / 4; margin:0 !important; padding:0 2px 4px; color:#334155 !important; font-size:14px !important; }
        .note { display:none; margin:13px 0 0; color:#334155; font-size:14px; }
        .score-icon.semaphore-slot { flex:0 0 auto; width:auto; height:auto; background:none; border-radius:0; }
        .semaphore { display:inline-flex; flex-direction:column; gap:4px; padding:6px 5px; border-radius:11px; background:#1f2937; box-shadow:inset 0 0 0 1px #0006; }
        .semaphore i { display:block; width:13px; height:13px; border-radius:50%; background:#4b5563; }
        .semaphore[data-light="red"] .lamp-red { background:#ef4444; box-shadow:0 0 9px #ef4444; }
        .semaphore[data-light="yellow"] .lamp-yellow { background:#facc15; box-shadow:0 0 9px #facc15; }
        .semaphore[data-light="green"] .lamp-green { background:#22c55e; box-shadow:0 0 9px #22c55e; }
        .score { font-size:28px; }
        .no-flags { margin:0; padding:10px 12px; border:1px solid #86efac; border-radius:12px; background:#f0fdf4; color:#166534 !important; font-weight:700; }
        .score-note { margin:12px 0 0 !important; color:#475569 !important; font-size:13px !important; }
        .details .note { display:block; }
        .recent-history { margin-top:14px; padding-top:10px; border-top:2px solid #e2e8f0; }
        .recent-history > summary { min-height:40px; padding:5px 2px; color:#1e3a8a; font-size:15px; font-weight:800; cursor:pointer; }
        .history-list { display:grid; gap:8px; }
        .history-entry { padding:9px; border:1px solid #cbd5e1; border-radius:12px; background:#fff; }
        .history-entry > summary { display:grid; gap:5px; cursor:pointer; list-style-position:inside; }
        .history-title { color:#111827; font-size:14px; font-weight:800; overflow-wrap:anywhere; }
        .history-score { width:max-content; padding:3px 7px; border:1px solid currentColor; border-radius:999px; font-size:12px; font-weight:800; }
        .history-score[data-status="low"] { color:#166534; background:#f0fdf4; }
        .history-score[data-status="careful"] { color:#92400e; background:#fffbeb; }
        .history-score[data-status="possible"] { color:#991b1b; background:#fef2f2; }
        .history-date { display:block; margin:6px 0; color:#64748b; font-size:12px; }
        .history-factors { display:grid; gap:5px; margin:6px 0 0; padding:0; list-style:none; }
        .history-factors li { display:grid; grid-template-columns:24px 1fr; gap:6px; padding:7px; border:1px solid #cbd5e1; border-radius:9px; background:#f8fafc; }
        .history-factors li[data-result="flag"] { border-color:#fca5a5; background:#fff7f7; }
        .history-factors li[data-result="clear"] { border-color:#86efac; background:#f0fdf4; }
        .history-factors li[data-result="unknown"] { border-color:#cbd5e1; background:#f8fafc; }
        .history-factors li > span:first-child { font-size:18px; }
        .history-factors strong, .history-factors small { display:block; }
        .history-factors small { margin-top:2px; color:#475569; font-size:12px; line-height:1.35; overflow-wrap:anywhere; }
        .history-empty { margin:4px 0; color:#475569; font-size:14px; }
        @media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition-duration:.01ms !important; } }
      </style>
      <button class="launcher" type="button" aria-expanded="false">${launcherLogo}<span class="status-icon" aria-hidden="true">…</span><span>Checking rental…</span></button>
      <section class="panel hidden" aria-label="RedFlag listing check">
        <div class="header">${panelLogo}<span class="heading">RedFlag</span><button class="close" type="button" aria-label="Close">×</button></div>
        <div class="score-card" data-status="pending"><div class="risk-line"><span class="score-icon" aria-hidden="true">…</span><span class="score-copy"><span class="eyebrow">CHECK RESULT</span><strong class="score">—</strong></span><span class="label">CHECKING</span></div><p class="summary">Checking this rental…</p><div class="quick-facts"></div></div>
        <button class="toggle hidden" type="button" aria-expanded="false">📋 See safety details</button>
        <button class="retry hidden" type="button">↻ Re-check Listing</button>
        <div class="details hidden"></div>
        <details class="recent-history"><summary>🕘 Recent listings</summary><div class="history-list"></div></details>
      </section>`;
    document.documentElement.append(overlayHost);
    renderRecentHistory(shadow);
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
      toggle.textContent = opening ? "▲ Hide details" : "🔎 See details";
      toggle.setAttribute("aria-expanded", String(opening));
    });
    retry.addEventListener("click", () => {
      retry.classList.add("hidden");
      checkOpenedListing().catch(renderDetailError);
    });
    return { shadow, launcher, panel };
  }

  function renderDetailResult(overlay, analysis) {
    const score = Math.max(0, Math.min(100, Math.round(Number(analysis.risk_score) || 0)));
    const light = lightOf(analysis);
    const flags = redFlags(analysis);
    const panel = overlay.shadow.querySelector(".panel");
    panel.classList.toggle("zero-score", light.color === "green");
    const card = overlay.shadow.querySelector(".score-card");
    card.dataset.status = light.status;
    overlay.shadow.querySelector(".score").textContent = light.headline;
    overlay.shadow.querySelector(".label").textContent = flags.length ? flagCountText(flags.length) : "All checks passed";
    const lightSlot = overlay.shadow.querySelector(".score-icon");
    lightSlot.classList.add("semaphore-slot");
    lightSlot.replaceChildren(makeSemaphore(light.color));
    overlay.shadow.querySelector(".summary").textContent = light.label;
    overlay.shadow.querySelector(".quick-facts").replaceChildren();
    overlay.launcher.querySelector(".status-icon").textContent = light.dot;

    const details = overlay.shadow.querySelector(".details");
    details.replaceChildren();
    const addText = (tag, text, parent = details) => {
      const element = document.createElement(tag);
      element.textContent = text;
      parent.append(element);
      return element;
    };
    addText("h3", `🚩 Red flags (${flags.length})`);
    if (flags.length) {
      const signals = new Map((analysis.signals || []).map((signal) => [signal.code, signal]));
      const flagList = document.createElement("ul");
      flagList.className = "factor-list";
      flags.forEach((row) => {
        const [icon, title] = flagName(row.code);
        const item = document.createElement("li");
        item.className = "factor";
        item.dataset.result = "flag";
        const glyph = document.createElement("span");
        glyph.className = "factor-icon";
        glyph.setAttribute("aria-hidden", "true");
        glyph.textContent = icon;
        item.append(glyph);
        addText("span", title, item).className = "factor-name";
        addText("span", "RED FLAG", item).className = "factor-result";
        const note = flagNote(row, signals);
        if (note) addText("p", note, item).className = "factor-note";
        flagList.append(item);
      });
      details.append(flagList);
    } else {
      addText("p", "✅ No red flags found. This listing passed all of the checks.").className = "no-flags";
    }
    addText("p", `Rule-based score: ${score}/100. A screening aid, not proof of fraud; verify the unit and who can rent it.`).className = "score-note";

    const toggle = overlay.shadow.querySelector(".toggle");
    toggle.classList.remove("hidden");
    toggle.textContent = "🔎 See details";
    toggle.setAttribute("aria-expanded", "false");
    overlay.shadow.querySelector(".retry").classList.toggle("hidden", light.color === "green");
    overlay.launcher.dataset.status = light.status;
    overlay.launcher.querySelector("span:last-child").textContent = flags.length
      ? `${light.headline} · ${flagCountText(flags.length)}`
      : light.headline;
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
    overlay.launcher.querySelector(".status-icon").textContent = "❌";
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
    const analysis = response.result;
    if (typeof analysis?.fake !== "boolean"
      || !["green", "yellow", "red"].includes(analysis?.risk_light?.color)
      || !Number.isInteger(analysis?.risk_light?.warnings)
      || !Number.isInteger(analysis?.votes?.fake)
      || !Number.isInteger(analysis?.votes?.real)
      || !Number.isInteger(analysis?.votes?.unknown)
      || typeof analysis.review_check_available !== "boolean"
      || !Array.isArray(analysis?.trees)
      || analysis.trees.length < 1
      || analysis.trees.length > 6
      || analysis.votes.fake + analysis.votes.real + analysis.votes.unknown !== analysis.trees.length
      || !analysis.trees.every((tree) => typeof tree === "string" && /^(?:fake|real|unknown)\s*\|\s*[a-z0-9_]+\s*\|\s*\S/i.test(tree))) {
      throw new Error("The backend replied, but its result format is outdated. Restart the updated backend and try again.");
    }
    renderDetailResult(overlay, analysis);
    await saveRecentCheck(listing, analysis);
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
    renderRecentHistory(overlayHost?.shadowRoot);
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

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes.recentChecks && overlayHost?.isConnected) {
      renderRecentHistory(overlayHost.shadowRoot);
    }
  });

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

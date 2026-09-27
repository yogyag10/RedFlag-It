(() => {
  if (window.__rentalShieldInstalled) return;
  window.__rentalShieldInstalled = true;

  const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
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

  function sectionText(lines, headingPattern, stopPattern) {
    const start = lines.findIndex((line) => headingPattern.test(line));
    if (start < 0) return "";
    const section = [];
    for (const line of lines.slice(start + 1)) {
      if (stopPattern.test(line)) break;
      section.push(line);
    }
    return section.join(" ");
  }

  function roomCount(text, kind) {
    const pattern = kind === "bedrooms"
      ? /\b(\d+(?:\.\d+)?)\s*[- ]?\s*(?:bed(?:room)?s?|br)\b/i
      : /\b(\d+(?:\.\d+)?)\s*[- ]?\s*(?:bath(?:room)?s?|ba)\b/i;
    const match = text.match(pattern);
    if (match) return Number(match[1]);
    return kind === "bedrooms" && /\bstudio\b/i.test(text) ? 0 : null;
  }

  function facebookListingRoot() {
    const main = document.querySelector('[role="main"]');
    const heading = main?.querySelector("h1") || document.querySelector("h1");
    if (!heading) return null;

    // Walk upward only until the listing details are found. Never use the whole
    // Marketplace main region: it can contain recommendations and other ads.
    for (let node = heading.parentElement; node && node !== main; node = node.parentElement) {
      const text = clean(node.innerText);
      const hasDetails = /\b(?:details|description|rental location|unit details)\b/i.test(text);
      const includesOtherContent = /\b(?:seller information|related searches|today's picks)\b/i.test(text);
      if (hasDetails && !includesOtherContent) return node;
    }
    return heading.parentElement;
  }

  function extractListing() {
    const craigslist = location.hostname.endsWith("craigslist.org");
    const listingRoot = craigslist ? null : facebookListingRoot();
    const lines = textLines(craigslist ? document.querySelector("#housing") || document.body : listingRoot);
    const title = craigslist
      ? firstText(["#titletextonly", "h1"])
      : clean(listingRoot?.querySelector("h1")?.innerText)
        || firstText(["meta[property='og:title']", "h1"]);
    const description = craigslist
      ? firstText(["#postingbody", "[itemprop='description']"])
      : sectionText(lines, /^description$/i, /^(?:getting around|seller information|seller details|more from this seller)$/i)
        || clean(listingRoot?.innerText);
    const priceText = craigslist
      ? firstText([".price", "[itemprop='price']"])
      : clean(listingRoot?.innerText);
    const priceMatch = priceText.match(/(?:CA\$|C\$|CAD\s*|\$)\s?([\d][\d,]*(?:\.\d{1,2})?)/i)
      || title.match(/(?:CA\$|C\$|CAD\s*|\$)\s?([\d][\d,]*(?:\.\d{1,2})?)/i);
    const price = priceMatch ? Number(priceMatch[1].replaceAll(",", "")) : null;
    const bodyText = clean(description).slice(0, 12000);
    const titleText = clean(title || document.title).slice(0, 300);
    const factsText = `${titleText}\n${lines.join("\n")}\n${bodyText}`;
    const bedrooms = roomCount(factsText, "bedrooms");
    const bathrooms = roomCount(factsText, "bathrooms");
    const pageImages = craigslist
      ? [...document.images]
      : [...new Set([
          ...listingRoot?.querySelectorAll('button[aria-label*="photo" i] img, [role="button"][aria-label*="photo" i] img') || [],
          ...(document.querySelector('[role="main"]') || document).querySelectorAll("img")
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
    const fullText = `${titleText} ${bodyText}`;
    const pricePeriod = /\b(?:per|a)\s*(?:week|wk)\b|\/\s*week/i.test(fullText)
      ? "week"
      : /\b(?:per|a)\s*day\b|\/\s*day/i.test(fullText)
        ? "day"
        : /\b(?:per|a)\s*night\b|\/\s*night/i.test(fullText)
          ? "night"
          : /\b(?:per|a)\s*month\b|\/\s*month/i.test(fullText) || !craigslist
            ? "month"
            : "unknown";
    return {
      title: titleText,
      description: bodyText,
      bedrooms,
      bathrooms,
      address: address.slice(0, 500) || null,
      price,
      currency: "CAD",
      price_period: pricePeriod,
      location_text: locationText.slice(0, 300),
      latitude,
      longitude,
      image_urls: imageUrls,
      source_url: location.href
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "RENTAL_SHIELD_EXTRACT") {
      try {
        sendResponse({ ok: true, listing: extractListing() });
      } catch (error) {
        sendResponse({ ok: false, error: String(error) });
      }
      return true;
    }
  });
})();

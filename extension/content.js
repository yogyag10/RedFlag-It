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

  function extractListing() {
    const craigslist = location.hostname.endsWith("craigslist.org");
    const title = firstText(craigslist
      ? ["#titletextonly", "h1"]
      : ["meta[property='og:title']", "h1", "[role='main'] h2"]);
    const description = firstText(craigslist
      ? ["#postingbody", "[itemprop='description']"]
      : ["meta[property='og:description']", "[data-pagelet*='MarketplacePDP']", "[role='main']"]);
    const priceText = firstText(craigslist
      ? [".price", "[itemprop='price']"]
      : ["meta[property='product:price:amount']", "[aria-label*='$']", "[role='main']"]);
    const priceMatch = priceText.match(/(?:CA\$|C\$|CAD\s*|\$)\s?([\d][\d,]*(?:\.\d{1,2})?)/i)
      || title.match(/(?:CA\$|C\$|CAD\s*|\$)\s?([\d][\d,]*(?:\.\d{1,2})?)/i);
    const price = priceMatch ? Number(priceMatch[1].replaceAll(",", "")) : null;
    const bodyText = clean(description).slice(0, 12000);
    const titleText = clean(title || document.title).slice(0, 300);
    const imageUrls = [...new Set([...document.images]
      .filter((img) => img.naturalWidth >= 220 && img.naturalHeight >= 140)
      .map((img) => img.currentSrc || img.src)
      .filter((src) => /^https?:/i.test(src)))]
      .filter((src) => !/profile|avatar|emoji|static_map|pixel|tracking/i.test(src))
      .slice(0, 8);
    let locationText = "";
    let latitude = null;
    let longitude = null;
    if (craigslist) {
      locationText = firstText([".mapaddress", "[itemprop='address']", ".postingtitletext small"]);
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
    }
    return {
      title: titleText,
      description: bodyText,
      price,
      currency: "CAD",
      price_period: /\b(?:per|a)\s*(?:week|wk)\b|\/\s*week/i.test(`${titleText} ${bodyText}`) ? "week" : "month",
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

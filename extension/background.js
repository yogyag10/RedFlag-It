async function postToAnalysisService(path, payload, timeoutMs) {
  const { apiUrl = "http://127.0.0.1:8000", apiKey = "" } = await chrome.storage.local.get(["apiUrl", "apiKey"]);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${apiUrl.replace(/\/+$/, "")}${path}`, {
      method: "POST",
      credentials: "omit",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.detail || `Analysis service returned ${response.status}.`);
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "REDFLAG_QUICK_SCORES") {
    postToAnalysisService("/api/quick-scores", { listings: message.listings || [] }, 15_000)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.name === "AbortError" ? "Quick checks timed out." : error.message }));
    return true;
  }
  if (message?.type === "REDFLAG_FULL_ANALYSIS") {
    postToAnalysisService("/api/analyze", message.listing || {}, 120_000)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.name === "AbortError" ? "The full listing check timed out." : error.message }));
    return true;
  }
});

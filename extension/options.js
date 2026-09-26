const urlField = document.getElementById("api-url");
const keyField = document.getElementById("api-key");
const status = document.getElementById("status");

chrome.storage.local.get({ apiUrl: "http://127.0.0.1:8000", apiKey: "" }, (settings) => {
  urlField.value = settings.apiUrl;
  keyField.value = settings.apiKey;
});

function setStatus(message, kind = "") {
  status.textContent = message;
  status.className = `status ${kind}`.trim();
}

document.getElementById("save").addEventListener("click", async () => {
  setStatus("");
  let parsed;
  try {
    parsed = new URL(urlField.value.trim());
    if (!(["http:", "https:"].includes(parsed.protocol)) || parsed.username || parsed.password) throw new Error();
  } catch (_) {
    setStatus("Enter a valid http or https service address.", "error");
    return;
  }
  const localHost = ["127.0.0.1", "localhost"].includes(parsed.hostname);
  if (!localHost && parsed.protocol !== "https:") {
    setStatus("Remote services need HTTPS. HTTP is allowed only on this computer.", "error");
    return;
  }
  if (!localHost) {
    const origin = `${parsed.protocol}//${parsed.host}/*`;
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (!granted) {
      setStatus("Chrome needs permission to contact that service.", "error");
      return;
    }
  }
  await chrome.storage.local.set({ apiUrl: parsed.origin, apiKey: keyField.value.trim() });
  setStatus("Settings saved.", "success");
});

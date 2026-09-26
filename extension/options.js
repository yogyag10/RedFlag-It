const urlField = document.getElementById("api-url");
const keyField = document.getElementById("api-key");
const status = document.getElementById("status");

chrome.storage.local.get({ apiUrl: "http://127.0.0.1:8000", apiKey: "" }, (settings) => {
  urlField.value = settings.apiUrl;
  keyField.value = settings.apiKey;
});

document.getElementById("save").addEventListener("click", async () => {
  status.textContent = "";
  let parsed;
  try {
    parsed = new URL(urlField.value.trim());
    if (!(["http:", "https:"].includes(parsed.protocol)) || parsed.username || parsed.password) throw new Error();
  } catch (_) {
    status.textContent = "Enter a valid http or https service URL.";
    status.style.color = "#ad3c31";
    return;
  }
  const localHost = ["127.0.0.1", "localhost"].includes(parsed.hostname);
  if (!localHost && parsed.protocol !== "https:") {
    status.textContent = "Remote services must use HTTPS. HTTP is allowed only for localhost.";
    status.style.color = "#ad3c31";
    return;
  }
  if (!localHost) {
    const origin = `${parsed.protocol}//${parsed.host}/*`;
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (!granted) {
      status.textContent = "Chrome needs permission to contact that server.";
      status.style.color = "#ad3c31";
      return;
    }
  }
  await chrome.storage.local.set({ apiUrl: parsed.origin, apiKey: keyField.value.trim() });
  status.textContent = "Settings saved.";
  status.style.color = "#08764c";
});

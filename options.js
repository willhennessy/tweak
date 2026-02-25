async function init() {
  const input = document.getElementById("api-key");
  const { apiKey = "" } = await chrome.storage.local.get("apiKey");
  input.value = apiKey;

  document.getElementById("toggle-visibility").addEventListener("click", () => {
    input.type = input.type === "password" ? "text" : "password";
  });

  document.getElementById("save-btn").addEventListener("click", saveKey);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveKey();
  });
}

async function saveKey() {
  const input = document.getElementById("api-key");
  const status = document.getElementById("save-status");
  const key = input.value.trim();

  if (!key) {
    showStatus("error", "Please enter an API key.");
    return;
  }

  if (!key.startsWith("sk-ant-")) {
    showStatus("error", "Key should start with sk-ant-");
    return;
  }

  await chrome.storage.local.set({ apiKey: key });
  showStatus("success", "API key saved.");
}

function showStatus(type, message) {
  const el = document.getElementById("save-status");
  el.className = `save-status ${type}`;
  el.textContent = message;
  setTimeout(() => {
    el.className = "save-status hidden";
  }, 3000);
}

init();

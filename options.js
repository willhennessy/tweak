async function init() {
  const { anthropicApiKey = "", codexApiKey = "", defaultProvider = "anthropic" } =
    await chrome.storage.local.get(["anthropicApiKey", "codexApiKey", "defaultProvider"]);

  document.getElementById("anthropic-key").value = anthropicApiKey;
  document.getElementById("codex-key").value = codexApiKey;

  const radio = document.querySelector(`input[name="default-provider"][value="${defaultProvider}"]`);
  if (radio) radio.checked = true;

  for (const btn of document.querySelectorAll(".toggle-visibility")) {
    btn.addEventListener("click", () => {
      const input = document.getElementById(btn.dataset.target);
      input.type = input.type === "password" ? "text" : "password";
    });
  }

  for (const input of document.querySelectorAll("#anthropic-key, #codex-key")) {
    input.addEventListener("input", updateDefaultProviderVisibility);
  }

  updateDefaultProviderVisibility();

  document.getElementById("save-btn").addEventListener("click", saveKeys);
}

function updateDefaultProviderVisibility() {
  const anthropicKey = document.getElementById("anthropic-key").value.trim();
  const codexKey = document.getElementById("codex-key").value.trim();
  const section = document.getElementById("default-provider-section");
  section.style.display = (anthropicKey && codexKey) ? "" : "none";
}

async function saveKeys() {
  const anthropicKey = document.getElementById("anthropic-key").value.trim();
  const codexKey = document.getElementById("codex-key").value.trim();

  if (!anthropicKey && !codexKey) {
    showStatus("error", "Please enter at least one API key.");
    return;
  }

  if (anthropicKey && !anthropicKey.startsWith("sk-ant-")) {
    showStatus("error", "Anthropic key should start with sk-ant-");
    return;
  }

  if (codexKey && !codexKey.startsWith("sk-")) {
    showStatus("error", "Codex key should start with sk-");
    return;
  }

  const selectedRadio = document.querySelector("input[name=\"default-provider\"]:checked");
  let defaultProvider = selectedRadio ? selectedRadio.value : "anthropic";

  // If only one key is set, that provider is the default
  if (anthropicKey && !codexKey) defaultProvider = "anthropic";
  if (codexKey && !anthropicKey) defaultProvider = "codex";

  await chrome.storage.local.set({ anthropicApiKey: anthropicKey, codexApiKey: codexKey, defaultProvider });

  // Migrate legacy apiKey entry if present
  await chrome.storage.local.remove("apiKey");

  showStatus("success", "Settings saved.");
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

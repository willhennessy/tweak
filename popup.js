let currentTabId = null;
let currentTab = "active";

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id;

  setupTabs();
  setupSubmit();
  setupOptions();
  await loadRecentPrompts();
  await loadActiveTweaks();
  await checkPickerError();
}

async function checkPickerError() {
  const { pickerError } = await chrome.storage.local.get("pickerError");
  if (pickerError && pickerError.tabId === currentTabId) {
    await chrome.storage.local.remove("pickerError");
    showStatus("error", pickerError.message);
  }
}

function setupTabs() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentTab = btn.dataset.tab;
      document
        .querySelectorAll(".tab-btn")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      document
        .getElementById("tab-recent")
        .classList.toggle("hidden", currentTab !== "recent");
      document
        .getElementById("tab-active")
        .classList.toggle("hidden", currentTab !== "active");
    });
  });
}

function setupOptions() {
  document.getElementById("options-btn").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });
}

function setupSubmit() {
  const input = document.getElementById("prompt-input");
  const applyBtn = document.getElementById("apply-btn");
  const pickBtn = document.getElementById("pick-btn");

  applyBtn.addEventListener("click", submitTweak);
  pickBtn.addEventListener("click", startPicker);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      submitTweak();
    }
  });
}

async function submitTweak() {
  const input = document.getElementById("prompt-input");
  const prompt = input.value.trim();
  if (!prompt) return;

  const btn = document.getElementById("apply-btn");
  btn.disabled = true;
  const { defaultProvider = "anthropic" } = await chrome.storage.local.get("defaultProvider");
  const providerName = defaultProvider === "codex" ? "Codex" : "Claude";
  btn.textContent = `Tweaking with ${providerName}...`;

  try {
    const response = await chrome.runtime.sendMessage({
      type: "APPLY_TWEAK",
      prompt,
      tabId: currentTabId,
    });

    if (response?.error) {
      showStatus("error", response.error);
      btn.textContent = "Apply to page";
      btn.disabled = false;
    } else {
      btn.textContent = "Tweaked!";
      input.value = "";
      await loadRecentPrompts();
      await loadActiveTweaks();
      setTimeout(() => {
        btn.textContent = "Apply to page";
        btn.disabled = false;
      }, 1000);
    }
  } catch (err) {
    showStatus("error", err.message || "Something went wrong.");
    btn.textContent = "Apply to page";
    btn.disabled = false;
  }
}

async function startPicker() {
  const input = document.getElementById("prompt-input");
  const prompt = input.value.trim();
  if (!prompt) return;

  const pickBtn = document.getElementById("pick-btn");
  pickBtn.disabled = true;
  pickBtn.querySelector(".btn-sublabel").textContent = "";
  pickBtn.childNodes[0].textContent = "Selecting...";

  await chrome.runtime.sendMessage({
    type: "START_PICKER",
    prompt,
    tabId: currentTabId,
  });

  window.close();
}

function showStatus(type, message) {
  const el = document.getElementById("status");
  el.className = `status ${type}`;
  el.textContent = message;
  setTimeout(() => {
    el.className = "status hidden";
  }, 4000);
}

async function loadRecentPrompts() {
  const { recentPrompts = [] } =
    await chrome.storage.local.get("recentPrompts");
  const list = document.getElementById("recent-list");
  const empty = document.getElementById("recent-empty");

  list.innerHTML = "";
  if (recentPrompts.length === 0) {
    empty.classList.remove("hidden");
    return;
  }

  empty.classList.add("hidden");
  for (const prompt of recentPrompts) {
    const li = document.createElement("li");
    li.className = "recent-item";
    li.textContent = prompt;
    li.title = prompt;
    li.addEventListener("click", () => {
      document.getElementById("prompt-input").value = prompt;
      document.getElementById("prompt-input").focus();
    });
    list.appendChild(li);
  }
}

async function loadActiveTweaks() {
  const list = document.getElementById("tweaks-list");
  const empty = document.getElementById("tweaks-empty");
  list.innerHTML = "";

  let tweaks = [];
  try {
    tweaks = await chrome.tabs.sendMessage(currentTabId, {
      type: "GET_TWEAKS",
    });
  } catch {
    // Content script not available on this page (e.g. chrome:// URLs)
  }

  if (!tweaks || tweaks.length === 0) {
    empty.classList.remove("hidden");
    return;
  }

  empty.classList.add("hidden");
  for (const tweak of [...tweaks].reverse()) {
    list.appendChild(createTweakItem(tweak));
  }
}

function createTweakItem(tweak) {
  const li = document.createElement("li");
  li.className = `tweak-item${tweak.enabled ? "" : " disabled"}`;
  li.dataset.id = tweak.id;

  const label = document.createElement("span");
  label.className = "tweak-label";
  label.textContent = tweak.prompt;
  label.title = tweak.prompt;

  const toggle = document.createElement("label");
  toggle.className = "toggle";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = tweak.enabled;
  checkbox.addEventListener("change", async () => {
    await chrome.tabs.sendMessage(currentTabId, {
      type: "TOGGLE_TWEAK",
      id: tweak.id,
      enabled: checkbox.checked,
    });
    if (checkbox.checked) {
      await chrome.scripting.insertCSS({
        target: { tabId: currentTabId },
        css: tweak.code,
      });
    } else {
      await chrome.scripting.removeCSS({
        target: { tabId: currentTabId },
        css: tweak.code,
      });
    }
    li.classList.toggle("disabled", !checkbox.checked);
  });

  const slider = document.createElement("span");
  slider.className = "toggle-slider";
  toggle.appendChild(checkbox);
  toggle.appendChild(slider);

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "delete-btn";
  deleteBtn.textContent = "×";
  deleteBtn.title = "Delete tweak";
  deleteBtn.addEventListener("click", async () => {
    await chrome.tabs.sendMessage(currentTabId, {
      type: "DELETE_TWEAK",
      id: tweak.id,
    });
    await chrome.scripting
      .removeCSS({ target: { tabId: currentTabId }, css: tweak.code })
      .catch(() => {});
    li.remove();
    const list = document.getElementById("tweaks-list");
    if (list.children.length === 0) {
      document.getElementById("tweaks-empty").classList.remove("hidden");
    }
  });

  li.appendChild(label);
  li.appendChild(toggle);
  li.appendChild(deleteBtn);
  return li;
}

init();

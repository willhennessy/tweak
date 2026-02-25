const domain = location.hostname;

// Listen for messages from background/popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_TWEAKS") {
    getTweaks().then(sendResponse);
    return true;
  }

  if (message.type === "TOGGLE_TWEAK") {
    toggleTweak(message.id, message.enabled).then(sendResponse);
    return true;
  }

  if (message.type === "DELETE_TWEAK") {
    deleteTweak(message.id).then(sendResponse);
    return true;
  }
});

async function getTweaks() {
  const { tweaks = {} } = await chrome.storage.local.get("tweaks");
  return tweaks[domain] || [];
}

async function toggleTweak(id, enabled) {
  const { tweaks = {} } = await chrome.storage.local.get("tweaks");
  const domainTweaks = tweaks[domain] || [];
  const tweak = domainTweaks.find((t) => t.id === id);
  if (tweak) {
    tweak.enabled = enabled;
    tweaks[domain] = domainTweaks;
    await chrome.storage.local.set({ tweaks });
  }
  return { success: true };
}

async function deleteTweak(id) {
  const { tweaks = {} } = await chrome.storage.local.get("tweaks");
  const domainTweaks = tweaks[domain] || [];
  tweaks[domain] = domainTweaks.filter((t) => t.id !== id);
  if (tweaks[domain].length === 0) {
    delete tweaks[domain];
  }
  await chrome.storage.local.set({ tweaks });
  return { success: true };
}

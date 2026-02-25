chrome.runtime.onInstalled.addListener(async () => {
  const { apiKey } = await chrome.storage.local.get("apiKey");
  if (!apiKey) {
    chrome.runtime.openOptionsPage();
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab.url) return;

  let domain;
  try {
    domain = new URL(tab.url).hostname;
  } catch {
    return;
  }

  const { tweaks = {} } = await chrome.storage.local.get("tweaks");
  const domainTweaks = (tweaks[domain] || []).filter((t) => t.enabled);

  for (const tweak of domainTweaks) {
    await chrome.scripting.insertCSS({
      target: { tabId },
      css: tweak.code,
    }).catch(() => {}); // ignore e.g. chrome:// pages
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "APPLY_TWEAK") {
    handleApplyTweak(message).then(sendResponse).catch((err) => {
      sendResponse({ error: err.message });
    });
    return true; // keep channel open for async response
  }
});

async function handleApplyTweak({ prompt, tabId }) {
  const { apiKey } = await chrome.storage.local.get("apiKey");
  if (!apiKey) {
    throw new Error("No API key set. Please configure it in the extension options.");
  }

  // Get the page DOM from the content script
  const [{ result: outerHTML }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => document.documentElement.outerHTML,
  });

  const code = await callAnthropicAPI(apiKey, outerHTML, prompt);

  // Generate a unique ID for this tweak
  const id = crypto.randomUUID();

  console.log('[Tweak] code:', code);

  await chrome.scripting.insertCSS({
    target: { tabId },
    css: code,
  });

  // Save tweak to storage from the background script
  const tab = await chrome.tabs.get(tabId);
  const domain = new URL(tab.url).hostname;
  const { tweaks = {} } = await chrome.storage.local.get("tweaks");
  const domainTweaks = tweaks[domain] || [];
  domainTweaks.push({ id, prompt, code, enabled: true, createdAt: Date.now() });
  tweaks[domain] = domainTweaks;
  await chrome.storage.local.set({ tweaks });

  // Save to recent prompts
  await saveRecentPrompt(prompt);

  return { success: true, id };
}

async function callAnthropicAPI(apiKey, outerHTML, prompt) {
  // Truncate DOM if too large (Anthropic has token limits)
  const maxDOMLength = 100000;
  const truncatedHTML =
    outerHTML.length > maxDOMLength
      ? outerHTML.slice(0, maxDOMLength) + "\n<!-- DOM truncated for length -->"
      : outerHTML;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system:
        `You are a browser automation expert. The user is viewing a third-party webpage and wants a visual change applied via injected CSS.

Return ONLY a valid CSS ruleset — no JavaScript, no markdown, no code fences, no <style> tags. Just raw CSS rules.

Rules:
- Use attribute selectors, class selectors, and structural selectors to target elements
- Use [aria-label*="Follow"], [data-control-name="follow"], or class-based selectors to target elements by their label or purpose
- CSS cannot select by text content — do not attempt it
- Use !important on every property to override existing styles
- Use comma-separated selectors to cover multiple possible element variations
- Example output: button[aria-label*="Follow"] { background-color: green !important; color: white !important; }`,
      messages: [
        {
          role: "user",
          content: `Page DOM:\n${truncatedHTML}\n\nUser request: ${prompt}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(
      error.error?.message || `API request failed with status ${response.status}`
    );
  }

  const data = await response.json();
  const raw = data.content[0].text.trim();
  // Strip markdown code fences Claude sometimes adds despite instructions
  return raw.replace(/^```(?:javascript|js)?\n?/, '').replace(/\n?```$/, '').trim();
}

async function saveRecentPrompt(prompt) {
  const { recentPrompts = [] } = await chrome.storage.local.get("recentPrompts");
  const updated = [prompt, ...recentPrompts.filter((p) => p !== prompt)].slice(0, 10);
  await chrome.storage.local.set({ recentPrompts: updated });
}

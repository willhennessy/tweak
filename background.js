chrome.runtime.onInstalled.addListener(async () => {
  const { anthropicApiKey, codexApiKey, apiKey } =
    await chrome.storage.local.get([
      "anthropicApiKey",
      "codexApiKey",
      "apiKey",
    ]);

  // Migrate legacy apiKey to anthropicApiKey
  if (apiKey && !anthropicApiKey) {
    await chrome.storage.local.set({ anthropicApiKey: apiKey });
    await chrome.storage.local.remove("apiKey");
  }

  const hasKey = anthropicApiKey || codexApiKey || apiKey;
  if (!hasKey) {
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
    await chrome.scripting
      .insertCSS({
        target: { tabId },
        css: tweak.code,
      })
      .catch(() => {}); // ignore e.g. chrome:// pages
  }
});

let pendingPick = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "APPLY_TWEAK") {
    handleApplyTweak(message)
      .then(sendResponse)
      .catch((err) => {
        sendResponse({ error: err.message });
      });
    return true; // keep channel open for async response
  }

  if (message.type === "START_PICKER") {
    const { tabId, prompt } = message;
    pendingPick = { tabId, prompt };
    chrome.tabs.sendMessage(tabId, { type: "START_PICKER" }).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "ELEMENT_SELECTED") {
    if (!pendingPick) return false;
    const { tabId, prompt } = pendingPick;
    pendingPick = null;
    handlePickerResult(tabId, prompt, message).catch(() => {});
    return false;
  }
});

function setBadge(tabId, text, color) {
  chrome.action.setBadgeText({ text, tabId });
  chrome.action.setBadgeBackgroundColor({ color, tabId });
}

function clearBadge(tabId) {
  chrome.action.setBadgeText({ text: "", tabId });
}

async function handlePickerResult(
  tabId,
  prompt,
  { simplifiedHTML, selectorPath },
) {
  const {
    anthropicApiKey = "",
    codexApiKey = "",
    defaultProvider = "anthropic",
  } = await chrome.storage.local.get([
    "anthropicApiKey",
    "codexApiKey",
    "defaultProvider",
  ]);

  if (!anthropicApiKey && !codexApiKey) {
    await chrome.storage.local.set({
      pickerError: {
        tabId,
        message:
          "No API key set. Please configure it in the extension options.",
      },
    });
    try {
      await chrome.action.openPopup();
    } catch {}
    return;
  }

  setBadge(tabId, "...", "#3b82f6");

  try {
    const code = await callAPIWithFallback(
      anthropicApiKey,
      codexApiKey,
      defaultProvider,
      null,
      prompt,
      { simplifiedHTML, selectorPath },
    );

    console.log("[Tweak] Output:", code);

    await chrome.scripting.insertCSS({ target: { tabId }, css: code });

    const tab = await chrome.tabs.get(tabId);
    const domain = new URL(tab.url).hostname;
    const { tweaks = {} } = await chrome.storage.local.get("tweaks");
    const domainTweaks = tweaks[domain] || [];
    const id = crypto.randomUUID();
    domainTweaks.push({
      id,
      prompt,
      code,
      enabled: true,
      createdAt: Date.now(),
    });
    tweaks[domain] = domainTweaks;
    await chrome.storage.local.set({ tweaks });
    await saveRecentPrompt(prompt);

    setBadge(tabId, "✓", "#16a34a");
    setTimeout(() => clearBadge(tabId), 1000);
  } catch (err) {
    clearBadge(tabId);
    await chrome.storage.local.set({
      pickerError: { tabId, message: err.message },
    });
    try {
      await chrome.action.openPopup();
    } catch {
      // chrome.action.openPopup() requires Chrome 127+ and user gesture; error stored for manual reopen
    }
  }
}

async function handleApplyTweak({ prompt, tabId }) {
  const {
    anthropicApiKey = "",
    codexApiKey = "",
    defaultProvider = "anthropic",
  } = await chrome.storage.local.get([
    "anthropicApiKey",
    "codexApiKey",
    "defaultProvider",
  ]);

  if (!anthropicApiKey && !codexApiKey) {
    throw new Error(
      "No API key set. Please configure it in the extension options.",
    );
  }

  // Extract a compact DOM skeleton: tags + identifying attributes, no content or SVGs.
  // This fits far more page structure into the token budget than raw outerHTML.
  const [{ result: domTree }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const SKIP = new Set(["script", "style", "svg", "noscript", "head"]);
      const ID_ATTRS = [
        "id",
        "class",
        "aria-label",
        "data-testid",
        "role",
        "name",
        "type",
        "slot",
        "placeholder",
      ];
      function simplify(node, depth) {
        if (depth > 15 || node.nodeType !== 1) return "";
        const tag = node.tagName.toLowerCase();
        if (SKIP.has(tag)) return "";
        const attrs = ID_ATTRS.map((a) => {
          const v = node.getAttribute(a);
          return v ? ` ${a}="${v}"` : "";
        }).join("");
        const children = Array.from(node.children)
          .map((c) => simplify(c, depth + 1))
          .filter(Boolean)
          .join("");
        return `<${tag}${attrs}>${children}</${tag}>`;
      }
      return simplify(document.documentElement, 0);
    },
  });

  const code = await callAPIWithFallback(
    anthropicApiKey,
    codexApiKey,
    defaultProvider,
    domTree,
    prompt,
  );

  // Generate a unique ID for this tweak
  const id = crypto.randomUUID();

  console.log("[Tweak] Output:", code);

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

async function callAPIWithFallback(
  anthropicApiKey,
  codexApiKey,
  defaultProvider,
  outerHTML,
  prompt,
  elementContext = null,
) {
  const primary = defaultProvider === "codex" ? "codex" : "anthropic";
  const fallback = primary === "anthropic" ? "codex" : "anthropic";

  const primaryKey = primary === "anthropic" ? anthropicApiKey : codexApiKey;
  const fallbackKey = fallback === "anthropic" ? anthropicApiKey : codexApiKey;

  if (primaryKey) {
    try {
      return await callAPI(
        primary,
        primaryKey,
        outerHTML,
        prompt,
        elementContext,
      );
    } catch (err) {
      console.warn(`[Tweak] ${primary} API failed:`, err.message);
      if (fallbackKey) {
        console.log(`[Tweak] Falling back to ${fallback} API`);
        return await callAPI(
          fallback,
          fallbackKey,
          outerHTML,
          prompt,
          elementContext,
        );
      }
      throw err;
    }
  }

  // Primary key not set, try fallback directly
  return await callAPI(
    fallback,
    fallbackKey,
    outerHTML,
    prompt,
    elementContext,
  );
}

async function callAPI(
  provider,
  apiKey,
  outerHTML,
  prompt,
  elementContext = null,
) {
  if (provider === "anthropic") {
    return callAnthropicAPI(apiKey, outerHTML, prompt, elementContext);
  }
  return callCodexAPI(apiKey, outerHTML, prompt, elementContext);
}

const SYSTEM_PROMPT = `You are a browser automation expert. The user is viewing a third-party webpage and wants a visual change applied via injected CSS.

You will be given either a compact DOM tree or a specific target element selected by the user. Use it to find the exact element to target.

Your response must be RAW CSS ONLY — no words, no explanation, no markdown, no code fences, no <style> tags. Start immediately with the first selector.

Rules:
- Use the exact tag names, IDs, and classes you see in the provided DOM — do not guess or invent selectors
- Prefer the most specific selector that uniquely identifies the element (e.g. custom element tag names like <recent-posts>, or #id selectors)
- When a specific target element is provided with a selector path, use that element's tag name, ID, or classes directly. The selectorPath shows its position in the DOM for context.
- Use !important on every property to override existing styles
- CSS cannot select by text content — use tag names, IDs, classes, and attribute selectors instead
- Example output: recent-posts { display: none !important; }`;

// Extract only the CSS from the response, discarding any prose the model prepended
function extractCSS(raw) {
  const firstBrace = raw.indexOf("{");
  if (firstBrace === -1) return raw.trim();
  const lineStart = raw.lastIndexOf("\n", firstBrace) + 1;
  return raw
    .slice(lineStart)
    .replace(/\n?```$/, "")
    .trim();
}

function buildUserContent(outerHTML, prompt, elementContext = null) {
  let content;
  let contextLabel;
  let contextValue;
  if (elementContext) {
    const { simplifiedHTML, selectorPath } = elementContext;
    content = `Target element (user-selected):\nSelector path: ${selectorPath}\n${simplifiedHTML}\n\nUser request: ${prompt}`;
    contextLabel = "Target element: user-selected,";
    contextValue = simplifiedHTML;
  } else {
    const maxDOMLength = 200000;
    const truncatedHTML =
      outerHTML.length > maxDOMLength
        ? outerHTML.slice(0, maxDOMLength) +
          "\n<!-- DOM truncated for length -->"
        : outerHTML;
    content = `Page DOM:\n${truncatedHTML}\n\nUser request: ${prompt}`;
    contextLabel = "Page DOM:";
    contextValue = truncatedHTML;
  }
  const estTokens = Math.round(content.length / 4);
  console.log(`[Tweak] User request: ${prompt}`);
  console.log(`[Tweak] Context tokens: ${estTokens}`);
  console.log(`[Tweak] ${contextLabel}`, contextValue);
  return content;
}

async function callAnthropicAPI(
  apiKey,
  outerHTML,
  prompt,
  elementContext = null,
) {
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
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: buildUserContent(outerHTML, prompt, elementContext),
        },
      ],
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(
      error.error?.message ||
        `Anthropic API request failed with status ${response.status}`,
    );
  }

  const data = await response.json();
  return extractCSS(data.content[0].text);
}

async function callCodexAPI(apiKey, outerHTML, prompt, elementContext = null) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o",
      max_tokens: 4096,
      messages: [
        {
          role: "system",
          content: SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: buildUserContent(outerHTML, prompt, elementContext),
        },
      ],
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(
      error.error?.message ||
        `Codex API request failed with status ${response.status}`,
    );
  }

  const data = await response.json();
  return extractCSS(data.choices[0].message.content);
}

async function saveRecentPrompt(prompt) {
  const { recentPrompts = [] } =
    await chrome.storage.local.get("recentPrompts");
  const updated = [prompt, ...recentPrompts.filter((p) => p !== prompt)].slice(
    0,
    10,
  );
  await chrome.storage.local.set({ recentPrompts: updated });
}

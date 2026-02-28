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
    await injectTweak(tabId, tweak).catch(() => {}); // ignore e.g. chrome:// pages
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

  if (message.type === "INJECT_TWEAK") {
    const { tabId, tweak } = message;
    injectTweak(tabId, tweak)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
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
    const tab = await chrome.tabs.get(tabId);
    const domain = new URL(tab.url).hostname;

    const { type, code } = await callAPIWithFallback(
      anthropicApiKey,
      codexApiKey,
      defaultProvider,
      null,
      prompt,
      { simplifiedHTML, selectorPath },
      tab.url,
    );

    console.log("[Tweak] Output:", { type, code });
    const { tweaks = {} } = await chrome.storage.local.get("tweaks");
    const domainTweaks = tweaks[domain] || [];
    const id = crypto.randomUUID();

    await injectTweak(tabId, { id, type, code });

    domainTweaks.push({
      id,
      prompt,
      code,
      type,
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

  const tab = await chrome.tabs.get(tabId);
  const domain = new URL(tab.url).hostname;

  const { type, code } = await callAPIWithFallback(
    anthropicApiKey,
    codexApiKey,
    defaultProvider,
    domTree,
    prompt,
    null,
    tab.url,
  );

  const id = crypto.randomUUID();

  console.log("[Tweak] Output:", { type, code });

  await injectTweak(tabId, { id, type, code });
  const { tweaks = {} } = await chrome.storage.local.get("tweaks");
  const domainTweaks = tweaks[domain] || [];
  domainTweaks.push({ id, prompt, code, type, enabled: true, createdAt: Date.now() });
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
  pageUrl = null,
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
        pageUrl,
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
          pageUrl,
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
    pageUrl,
  );
}

async function callAPI(
  provider,
  apiKey,
  outerHTML,
  prompt,
  elementContext = null,
  pageUrl = null,
) {
  if (provider === "anthropic") {
    return callAnthropicAPI(apiKey, outerHTML, prompt, elementContext, pageUrl);
  }
  return callCodexAPI(apiKey, outerHTML, prompt, elementContext, pageUrl);
}

const SYSTEM_PROMPT = `You are a browser automation expert. The user is viewing a third-party webpage and wants a change applied via injected CSS or JS.

You will be given either a compact DOM tree or a specific target element selected by the user. Use it to find the exact element to target.

Respond with a single JSON object — no prose, no markdown fences:
{ "type": "css", "code": "..." }
or
{ "type": "js", "code": "..." }

Choose the type based on the request:
- Use "css" for visual changes: hiding, resizing, recoloring, repositioning elements
- Use "js" for DOM mutations: adding elements, restructuring content, building interactive UI (tabs, toggles, etc.)

CSS rules:
- Use the exact tag names, IDs, and classes you see in the provided DOM — do not guess or invent selectors
- Prefer the most specific selector that uniquely identifies the element (e.g. custom element tag names like <recent-posts>, or #id selectors)
- When a specific target element is provided with a selector path, use that element's tag name, ID, or classes directly. The selectorPath shows its position in the DOM for context.
- Use !important on every property to override existing styles
- CSS cannot select by text content — use tag names, IDs, classes, and attribute selectors instead

JS rules:
- Write self-contained code that operates on document (no imports, no require)
- Use standard DOM APIs only`;

// Parse the LLM response into { type, code }. Handles JSON with optional markdown fences.
// Falls back to treating the raw text as CSS if JSON parsing fails.
function parseResponse(raw) {
  const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  let parsed;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    // Fallback: assume raw CSS
    return { type: "css", code: raw.trim() };
  }
  if (parsed && (parsed.type === "css" || parsed.type === "js") && typeof parsed.code === "string") {
    return parsed;
  }
  return { type: "css", code: raw.trim() };
}

// Inject a tweak into the page. CSS tweaks use insertCSS; JS tweaks use executeScript.
// The idempotency guard (data-tweak-id meta tag) prevents duplicate JS injection on reload.
async function injectTweak(tabId, tweak) {
  const type = tweak.type || "css";
  if (type === "js") {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (id, code) => {
        if (document.querySelector(`[data-tweak-id="${id}"]`)) return;
        (0, eval)(code); // eslint-disable-line no-eval
        const m = document.createElement("meta");
        m.setAttribute("data-tweak-id", id);
        document.head.appendChild(m);
      },
      args: [tweak.id, tweak.code],
    });
  } else {
    await chrome.scripting.insertCSS({ target: { tabId }, css: tweak.code });
  }
}

function buildUserContent(outerHTML, prompt, elementContext = null, pageUrl = null) {
  let content;
  let contextLabel;
  let contextValue;
  const urlLine = pageUrl ? `Page URL: ${pageUrl}\n` : "";
  if (elementContext) {
    const { simplifiedHTML, selectorPath } = elementContext;
    content = `${urlLine}Target element (user-selected):\nSelector path: ${selectorPath}\n${simplifiedHTML}\n\nUser request: ${prompt}`;
    contextLabel = "Target element: user-selected,";
    contextValue = simplifiedHTML;
  } else {
    const maxDOMLength = 200000;
    const truncatedHTML =
      outerHTML.length > maxDOMLength
        ? outerHTML.slice(0, maxDOMLength) +
          "\n<!-- DOM truncated for length -->"
        : outerHTML;
    content = `${urlLine}Page DOM:\n${truncatedHTML}\n\nUser request: ${prompt}`;
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
  pageUrl = null,
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
          content: buildUserContent(outerHTML, prompt, elementContext, pageUrl),
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
  return parseResponse(data.content[0].text);
}

async function callCodexAPI(apiKey, outerHTML, prompt, elementContext = null, pageUrl = null) {
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
          content: buildUserContent(outerHTML, prompt, elementContext, pageUrl),
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
  return parseResponse(data.choices[0].message.content);
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

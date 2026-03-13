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

  if (message.type === "LOG") {
    console.log(...message.args);
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

  console.log("[Tweak] Page DOM:", simplifiedHTML);

  try {
    const tab = await chrome.tabs.get(tabId);
    const domain = new URL(tab.url).hostname;
    const pageScreenshot = await captureTabScreenshot(tab.windowId);

    const { type, code } = await callAPIWithFallback(
      anthropicApiKey,
      codexApiKey,
      defaultProvider,
      null,
      prompt,
      { simplifiedHTML, selectorPath },
      tab.url,
      pageScreenshot,
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

  // Extract a compact DOM skeleton with Smart Skeleton enhancements:
  // text hints, deduplication, wrapper collapsing, class pruning, href/alt, landmark comments.
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
      const LANDMARKS = {
        main: "MAIN CONTENT",
        nav: "NAVIGATION",
        header: "HEADER",
        footer: "FOOTER",
        aside: "SIDEBAR",
      };
      const WRAPPER_SKIP_TAGS = new Set([
        "main",
        "article",
        "section",
        "nav",
        "header",
        "footer",
        "aside",
      ]);
      // Matches Tailwind/utility class prefixes — pruned to reduce token noise.
      const UTILITY_RE =
        /^(p[xytblr]?|m[xytblr]?|w-|h-|min-|max-|text-|font-|bg-|border|rounded|shadow|flex|grid|gap-|space-|leading-|tracking-|opacity-|overflow-|z-|absolute|relative|fixed|sticky|block|inline|hidden|transition|duration|cursor|transform|rotate|scale|translate|animate)-?\d*/;
      // Matches generated/hashed class names: styled-components, Emotion, CSS Modules.
      const GENERATED_RE =
        /^(sc-[a-zA-Z0-9]+|css-[a-zA-Z0-9]+|[a-z]{1,2}[A-Z][a-zA-Z]{3,}|_[a-zA-Z]+_[a-zA-Z0-9]+_\d+)$/;

      function pruneClasses(classStr) {
        const parts = classStr.split(/\s+/);
        const kept = parts.filter(
          (c) => !UTILITY_RE.test(c) && !GENERATED_RE.test(c),
        );
        // Fallback: keep first 2 original classes so element is never classless.
        return kept.length > 0 ? kept.join(" ") : parts.slice(0, 2).join(" ");
      }

      // A wrapper is a classless, ID-less, role-less element with exactly one element child.
      // We recurse through it without incrementing depth so real leaf nodes aren't pruned.
      function isWrapper(node) {
        if (node.children.length !== 1) return false;
        if (WRAPPER_SKIP_TAGS.has(node.tagName.toLowerCase())) return false;
        return !node.id && !node.className && !node.getAttribute("role");
      }

      // Normalize a skeleton string for structural comparison: strip dynamic values
      // (data-text, href, alt) so siblings sharing structure but differing in content
      // (e.g. Reddit/Twitter feed posts) are recognized as duplicates.
      function normalizeForDedup(s) {
        return s
          .replace(/data-text="[^"]*"/g, 'data-text=""')
          .replace(/href="[^"]*"/g, 'href=""')
          .replace(/alt="[^"]*"/g, 'alt=""');
      }

      // Collapse runs of 3+ consecutive structurally identical sibling skeletons.
      function deduplicateChildren(outputs) {
        const result = [];
        let i = 0;
        while (i < outputs.length) {
          const normI = normalizeForDedup(outputs[i]);
          let j = i + 1;
          while (j < outputs.length && normalizeForDedup(outputs[j]) === normI)
            j++;
          result.push(outputs[i]); // keep first (has real text/href)
          if (j - i - 1 >= 2) result.push(`<!-- +${j - i - 1} similar -->`);
          i = j;
        }
        return result;
      }

      function simplify(node, depth) {
        if (depth > 20 || node.nodeType !== 1) return "";
        const tag = node.tagName.toLowerCase();
        if (SKIP.has(tag)) return "";

        // Skip invisible nodes — user can't see or target them.
        if (
          node.hidden ||
          node.getAttribute("aria-hidden") === "true" ||
          node.style.display === "none" ||
          node.style.visibility === "hidden"
        )
          return "";

        // Wrapper collapsing: pass through without incrementing depth.
        if (isWrapper(node)) return simplify(node.children[0], depth);

        let attrs = ID_ATTRS.map((a) => {
          const v = node.getAttribute(a);
          if (!v) return "";
          if (a === "class") return ` class="${pruneClasses(v)}"`;
          return ` ${a}="${v}"`;
        }).join("");

        // Emit first 40 chars of direct (non-descendant) text so the LLM can
        // identify elements by visible label without targeting data-text in selectors.
        const directText = Array.from(node.childNodes)
          .filter((n) => n.nodeType === 3)
          .map((n) => n.textContent.trim())
          .join(" ")
          .slice(0, 40)
          .replace(/"/g, "&quot;");
        if (directText) attrs += ` data-text="${directText}"`;

        // Preserve href on links and alt on images as identification signals.
        if (tag === "a") {
          const href = node.getAttribute("href");
          if (href) attrs += ` href="${href.slice(0, 60)}"`;
        } else if (tag === "img") {
          const alt = node.getAttribute("alt");
          if (alt)
            attrs += ` alt="${alt.slice(0, 40).replace(/"/g, "&quot;")}"`;
        }

        // Interactive state — helps with dropdowns, tabs, checkboxes, toggles.
        for (const a of [
          "aria-expanded",
          "aria-selected",
          "aria-checked",
          "aria-current",
        ]) {
          const v = node.getAttribute(a);
          if (v !== null) attrs += ` ${a}="${v}"`;
        }

        // title — tooltip text; crucial for icon-only buttons.
        const title = node.getAttribute("title");
        if (title)
          attrs += ` title="${title.slice(0, 40).replace(/"/g, "&quot;")}"`;

        // Form attributes — expose current value and label associations.
        if (tag === "input" || tag === "textarea") {
          const val = node.value; // live DOM property, reflects user input
          if (val)
            attrs += ` value="${val.slice(0, 40).replace(/"/g, "&quot;")}"`;
        }
        if (tag === "label") {
          const forAttr = node.getAttribute("for");
          if (forAttr) attrs += ` for="${forAttr}"`;
        }
        if (tag === "form") {
          const action = node.getAttribute("action");
          if (action) attrs += ` action="${action.slice(0, 60)}"`;
        }

        const landmark = LANDMARKS[tag] ? `\n<!-- ${LANDMARKS[tag]} -->\n` : "";
        const childOutputs = Array.from(node.children)
          .map((c) => simplify(c, depth + 1))
          .filter(Boolean);
        const children = deduplicateChildren(childOutputs).join("");
        return `${landmark}<${tag}${attrs}>${children}</${tag}>`;
      }

      return simplify(document.documentElement, 0);
    },
  });

  console.log("[Tweak] Page DOM:", domTree);

  const tab = await chrome.tabs.get(tabId);
  const domain = new URL(tab.url).hostname;
  const pageScreenshot = await captureTabScreenshot(tab.windowId);

  const { type, code } = await callAPIWithFallback(
    anthropicApiKey,
    codexApiKey,
    defaultProvider,
    domTree,
    prompt,
    null,
    tab.url,
    pageScreenshot,
  );

  const id = crypto.randomUUID();

  console.log("[Tweak] Output:", { type, code });

  await injectTweak(tabId, { id, type, code });
  const { tweaks = {} } = await chrome.storage.local.get("tweaks");
  const domainTweaks = tweaks[domain] || [];
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
  pageScreenshot = null,
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
        pageScreenshot,
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
          pageScreenshot,
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
    pageScreenshot,
  );
}

async function callAPI(
  provider,
  apiKey,
  outerHTML,
  prompt,
  elementContext = null,
  pageUrl = null,
  pageScreenshot = null,
) {
  if (provider === "anthropic") {
    return callAnthropicAPI(
      apiKey,
      outerHTML,
      prompt,
      elementContext,
      pageUrl,
      pageScreenshot,
    );
  }
  return callCodexAPI(
    apiKey,
    outerHTML,
    prompt,
    elementContext,
    pageUrl,
    pageScreenshot,
  );
}

const SYSTEM_PROMPT = `You are a browser automation expert. The user is viewing a third-party webpage and wants a change applied via injected CSS or JS.

You will be given either a compact DOM tree or a specific target element selected by the user. You may also receive a screenshot of the webpage; this screenshot can help locate the element the user is referring to.

<output_format>
Respond with a single JSON object — no prose, no markdown fences:
{ "type": "css", "code": "..." }
or
{ "type": "js", "code": "..." }

Choose the type based on the request:
- Use "css" for visual changes: hiding, resizing, recoloring, repositioning elements
- Use "js" for DOM mutations: adding elements, restructuring content, building interactive UI (tabs, toggles, etc.)
</output_format>

<css_rules>
- Use the exact tag names, IDs, and classes you see in the provided DOM. Invented selectors will silently fail to match anything.
- Prefer the most specific selector that uniquely identifies the element (e.g. custom element tag names like <recent-posts>, or #id selectors)
- When a specific target element is provided with a selector path, use that element's tag name, ID, or classes directly. The selectorPath shows its position in the DOM for context.
- Use !important on every property so injected styles override the page's own stylesheet rules
- Selectors must use tag names, IDs, classes, and attribute selectors. CSS cannot select by text content.
- data-text attributes in the DOM are hints showing visible text for your reference only. Write selectors using tag names, IDs, and classes instead.
</css_rules>

<js_rules>
- Write self-contained code that operates on document (no imports, no require)
- Use standard DOM APIs only
</js_rules>`;

// Parse the LLM response into { type, code }. Handles JSON with optional markdown fences.
// Falls back to treating the raw text as CSS if JSON parsing fails.
function parseResponse(raw) {
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  let parsed;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    // Fallback: assume raw CSS
    return { type: "css", code: raw.trim() };
  }
  if (
    parsed &&
    (parsed.type === "css" || parsed.type === "js") &&
    typeof parsed.code === "string"
  ) {
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

function buildUserContent(
  outerHTML,
  prompt,
  elementContext = null,
  pageUrl = null,
) {
  let content;
  let contextLabel;
  let contextValue;
  const urlLine = pageUrl ? `Page URL: ${pageUrl}\n` : "";
  if (elementContext) {
    const { simplifiedHTML, selectorPath } = elementContext;
    content = `<target_element>\nSelector path: ${selectorPath}\n${simplifiedHTML}\n</target_element>\n\n${urlLine}<user_request>${prompt}</user_request>`;
    contextLabel = "Target element: user-selected,";
    contextValue = simplifiedHTML;
  } else {
    const maxDOMLength = 200000;
    const truncatedHTML =
      outerHTML.length > maxDOMLength
        ? outerHTML.slice(0, maxDOMLength) +
          "\n<!-- DOM truncated for length -->"
        : outerHTML;
    content = `<dom>\n${truncatedHTML}\n</dom>\n\n${urlLine}<user_request>${prompt}</user_request>`;
    contextLabel = "apply to full page";
    contextValue = null;
  }
  const estTokens = Math.round(content.length / 4);
  console.log(`[Tweak] User request: ${prompt}`);
  console.log(`[Tweak] Context tokens: ${estTokens}`);
  console.log(`[Tweak] ${contextLabel}`);
  return content;
}

async function callAnthropicAPI(
  apiKey,
  outerHTML,
  prompt,
  elementContext = null,
  pageUrl = null,
  pageScreenshot = null,
) {
  const userContent = buildUserContent(outerHTML, prompt, elementContext, pageUrl);
  const anthropicContent = [{ type: "text", text: userContent }];
  if (pageScreenshot) {
    anthropicContent.push({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: pageScreenshot.replace(/^data:image\/png;base64,/, ""),
      },
    });
  }

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
          content: anthropicContent,
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

async function callCodexAPI(
  apiKey,
  outerHTML,
  prompt,
  elementContext = null,
  pageUrl = null,
  pageScreenshot = null,
) {
  const userContent = buildUserContent(outerHTML, prompt, elementContext, pageUrl);
  const codexContent = [{ type: "text", text: userContent }];
  if (pageScreenshot) {
    codexContent.push({
      type: "image_url",
      image_url: { url: pageScreenshot },
    });
  }

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
          content: codexContent,
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

async function captureTabScreenshot(windowId) {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
      format: "png",
    });
    return dataUrl || null;
  } catch (err) {
    console.warn("[Tweak] Failed to capture screenshot:", err.message);
    return null;
  }
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

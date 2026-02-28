# Tweak — Agent Instructions

## What this project is
A Chrome extension (Manifest V3) that lets users describe visual or DOM changes to any webpage in natural language. The extension sends a compact DOM representation to an LLM (Claude or GPT-4o) and injects the resulting CSS or JS into the page.

## Project structure
```
manifest.json   — MV3 manifest; permissions: activeTab, scripting, storage, tabs
background.js   — Service worker: handles messages, calls LLM API, injects output
content.js      — Injected into all pages: manages tweaks, element picker
popup.html/css/js — Extension popup UI
options.html/css/js — API key + provider settings
```

## Critical architecture rules

### Output format (background.js)
- The LLM currently returns **raw CSS only**. Any change to support JS output must update the system prompt AND the `parseResponse`/`extractCSS` logic together.
- `buildUserContent()` builds the user message and also fires all console logs. Don't split the log calls away from this function.
- `callAPIWithFallback()` → `callAPI()` → `callAnthropicAPI()` / `callCodexAPI()`: all three levels thread `elementContext` through. If you add new parameters, add them at all three levels.

### CSS injection (background.js + popup.js)
- `chrome.scripting.insertCSS()` is used in `background.js` (on apply) AND in `popup.js` (on toggle re-enable).
- `chrome.scripting.removeCSS()` is used in `popup.js` (on toggle disable and on delete).
- The `tabs.onUpdated` listener in `background.js` re-injects all enabled CSS tweaks on every page load. Any new tweak type must also be handled here.

### Tweak storage schema
Tweaks are stored in `chrome.storage.local` under `tweaks[domain]` as an array:
```js
{ id, prompt, code, enabled, createdAt }
```
- `id`: `crypto.randomUUID()`
- `code`: the raw CSS string (or JS string if JS tweaks are added)
- If you add a `type` field for CSS vs JS, default missing `type` to `"css"` everywhere for backward compat.

### Two apply paths
1. **"Apply to page"** (`handleApplyTweak`): extracts full DOM skeleton via `executeScript`, sends to LLM, injects CSS.
2. **"Select region"** (`handlePickerResult`): receives `{ simplifiedHTML, selectorPath }` from content script picker, sends to LLM with element context, injects CSS. Uses badge on extension icon (blue `...` → green `✓`).
- Keep both paths in sync when changing injection or storage logic.

### Element picker (content.js)
- Uses `[data-tweak-highlight]` attribute (NOT `id`) for the hover outline, to avoid overwriting real element IDs.
- Listeners: `mousemove`, `click` (capture phase with `preventDefault`+`stopPropagation`), `keydown` (Escape to cancel).
- `extractElement()` produces `{ simplifiedHTML, selectorPath }`. `simplifiedHTML` is a depth-5 skeleton; `selectorPath` is the ancestor chain up to `<body>`.

### Picker error flow
- On error in `handlePickerResult`: store `{ tabId, message }` in `chrome.storage.local` as `pickerError`, then call `chrome.action.openPopup()`.
- On popup open: `checkPickerError()` in `init()` reads and clears `pickerError`, shows it as an error status.
- `chrome.action.openPopup()` requires Chrome 127+; wrap in try/catch.

### Toggle / delete (popup.js)
- Toggle and delete both talk directly to the content script (`TOGGLE_TWEAK`, `DELETE_TWEAK`) for the in-memory state, then call `insertCSS`/`removeCSS` from the popup.
- The popup already has `scripting` permission access via the `chrome.scripting` API.

## Lessons learned / things to avoid

### Do NOT overwrite element IDs for highlighting
The first picker implementation used `element.setAttribute('id', 'tweak-highlight')`, which destroys the element's real ID and corrupts selectors. Always use a `data-` attribute for picker highlighting.

### Do NOT split logging from buildUserContent
All request logs (user request, token count, context) live in `buildUserContent()`. This guarantees they fire exactly once per API call regardless of which path (apply vs picker) triggered it.

### Do NOT forget to thread new parameters through all call levels
`callAPIWithFallback` → `callAPI` → `callAnthropicAPI`/`callCodexAPI` all need the same signature. If you add `elementContext`, add it at every level with a default of `null`.

### Do NOT assume re-injection is only in one place
The `tabs.onUpdated` handler must be updated whenever you change the injection mechanism. It's easy to update `handleApplyTweak` and forget this listener.

### JSON output format (future JS support)
When switching the LLM to return JSON `{ type, code }` instead of raw CSS:
- Update `extractCSS()` → `parseResponse()` to JSON-parse and validate shape
- Update `SYSTEM_PROMPT` to describe the JSON format
- Update both `callAnthropicAPI` and `callCodexAPI` to call `parseResponse` not `extractCSS`
- The JSON must handle the case where the model still wraps output in markdown fences (strip ` ```json ` / ` ``` `)

## Current button layout
```
[ Select region        ] [ Apply to page ]
  (primary, white bg)     (ghost, muted)
```
"Select region" is the primary action (better results, fewer tokens).

## Token budget
- "Apply to page" on a complex page (Reddit): ~15,000 tokens input
- "Select region": ~75–200 tokens input
- DOM skeleton depth is capped at 15 for full-page, 5 for element picker

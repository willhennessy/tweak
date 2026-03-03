# Tweak — Engineering Plan

## Overview
Chrome extension that lets users customize any website using natural language. Claude generates JavaScript that modifies the DOM. Tweaks persist across page loads by storing generated code keyed by domain.

## Architecture

### Files
```
tweak/
├── manifest.json        # MV3, permissions: activeTab, scripting, storage, tabs
├── background.js        # Service worker — Anthropic API calls, recent prompts
├── content.js           # Injected into pages — applies/stores/toggles/deletes tweaks
├── popup.html/js/css    # UI: prompt input, Recent Prompts tab, Active Tweaks tab
├── options.html/js/css  # Settings: API key input
└── icons/               # 16, 48, 128px PNGs
```

### Data model (`chrome.storage.local`)
```json
{
  "apiKey": "sk-ant-...",
  "tweaks": {
    "reddit.com": [
      { "id": "uuid", "prompt": "...", "code": "...", "enabled": true, "createdAt": 123 }
    ]
  },
  "recentPrompts": ["...", "..."]
}
```

## Message Flow

```
popup.js
  → chrome.runtime.sendMessage({type: "APPLY_TWEAK", prompt, tabId})

background.js
  → chrome.scripting.executeScript → gets document.documentElement.outerHTML
  → POST https://api.anthropic.com/v1/messages (claude-sonnet-4-6)
  → chrome.tabs.sendMessage({type: "EXECUTE_TWEAK", code, id, prompt})
  → saves prompt to recentPrompts

content.js
  → executes code via new Function(code)()
  → saves tweak to chrome.storage.local under domain key
```

## Anthropic API

- **Model**: `claude-sonnet-4-6`
- **System prompt**: "You are a staff web engineer. The end user is viewing your webpage in real time and requested the following change. Modify the DOM to achieve the desired change for the user. Return ONLY executable JavaScript code — no explanation, no markdown, no code fences. The code will be executed directly in the browser."
- **User message**: `"Page DOM:\n{outerHTML}\n\nUser request: {prompt}"`
- **DOM truncation**: capped at 100,000 chars to avoid token limits

## Content Script Lifecycle

On every `document_idle`:
1. Read `tweaks[location.hostname]` from storage
2. For each enabled tweak, run `new Function(tweak.code)()`

Message handlers:
- `EXECUTE_TWEAK` — run code, append tweak to domain array in storage
- `GET_TWEAKS` — return tweaks for current domain
- `TOGGLE_TWEAK` — flip `enabled` flag in storage
- `DELETE_TWEAK` — remove tweak from domain array; delete key if empty

## Popup UI

- Textarea + Apply button (Cmd/Ctrl+Enter shortcut)
- Status bar: loading / success (auto-clears after 3s) / error states
- **Recent Prompts tab**: last 10 unique prompts, clickable to pre-fill input
- **Active Tweaks tab**: newest-first, toggle switch + delete (×) per tweak

## Options Page

- Password input for API key with show/hide toggle
- Validates prefix `sk-ant-`
- Opens automatically on first install if no key is stored
- Link to `https://console.anthropic.com/`

## Loading the Extension

1. `chrome://extensions` → enable Developer mode
2. Load unpacked → select `tweak/` directory
3. Options page opens → enter API key → Save

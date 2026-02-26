# Tweak

Tweak any webpage with a prompt.

For example:

- Hide all headlines about the NBA
- Convert this page to dark mode
- Change the font style to inter

## Getting started

### 1. Clone the repo

```bash
git clone https://github.com/willhennessy/tweak.git
cd tweak
```

No build step required. This is a plain HTML/CSS/JS extension.

### 2. Load the extension in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (toggle in the top right)
3. Click **Load unpacked**
4. Select the `tweak` folder

### 3. Add your API key

1. Click the Tweak icon in your toolbar
2. Paste your [Anthropic API key](https://console.anthropic.com/) and save
3. Pin the Tweak icon in your toolbar

### 4. Use it

1. Navigate to any webpage
2. Click the Tweak icon
3. Type a visual change (e.g. "make the follow button green")
4. Press **Apply** or `Cmd+Enter`

Applied tweaks are saved per domain and re-injected automatically on future page loads. You can toggle or delete them from the **Active** tab in the popup.

## Requirements

- Chrome 116+
- Anthropic API key (Claude)
- coming soon: Codex API key
- coming soon: freemium model, no API key required

## How it works

Tweak sends the page's HTML and your prompt to Claude, which returns a CSS ruleset. The extension injects that CSS directly into the page using Chrome's `scripting.insertCSS` API — no eval, no JavaScript execution, no CSP issues.

Tweaks are stored in `chrome.storage.local` keyed by domain and re-applied via a `tabs.onUpdated` listener on each page load.

## Project structure

```
manifest.json   Chrome extension manifest (MV3)
background.js   Service worker — handles Claude API calls and CSS injection
content.js      Content script — manages tweak storage per domain
popup.html/js   Extension popup UI
options.html/js API key settings page
```

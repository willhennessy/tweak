# DOM Extraction & Simplification in Tweak

## The core problem

A raw page's `outerHTML` on a site like Reddit or GitHub can be 500KB–2MB. Sending that to an LLM is expensive, slow, and mostly noise — the model only needs structural/selector information, not text content or styles. The algorithm strips a real DOM down to a **structural skeleton** the LLM can use to write precise CSS/JS selectors.

---

## Two extraction modes

The extension has two paths, each with a different depth limit based on how much context is needed:

```
User action
    │
    ├─── "Apply to page" ──────► Full-page skeleton
    │                             depth ≤ 15, from <html>
    │                             ~15,000 tokens on complex pages
    │
    └─── "Select region" ──────► Element-scoped skeleton
                                  depth ≤ 5, from selected element
                                  + ancestor selectorPath
                                  ~75–200 tokens
```

---

## Path 1: Full-page extraction (`background.js:183–213`)

Runs inside the page via `chrome.scripting.executeScript`, so it has direct DOM access.

**Algorithm — `simplify(node, depth)`:**

```
simplify(node, depth)
│
├─ depth > 15?  ──► return ''   (depth cap)
├─ not Element? ──► return ''   (skip text/comment nodes)
├─ tag in SKIP? ──► return ''   (skip script/style/svg/noscript/head)
│
├─ collect whitelisted attributes:
│    id, class, aria-label, data-testid,
│    role, name, type, slot, placeholder
│    (only those actually present on the node)
│
├─ recurse into node.children (not childNodes — skips text nodes natively)
│
└─ return "<tag attr1="..." attr2="...">{{children}}</tag>"
```

**What gets stripped:**

| Kept | Stripped |
|---|---|
| Tag name | Text content |
| `id`, `class` | `style` attributes |
| ARIA labels | Event handlers |
| `data-testid`, `role` | All other `data-*` attrs |
| `name`, `type`, `slot`, `placeholder` | Comments |
| Element structure | `<script>`, `<style>`, `<svg>`, `<noscript>` subtrees |

---

## Path 2: Element picker extraction (`content.js:74–100`)

Triggered when the user hovers and clicks a region. Same `simplify` logic but with two differences:

1. **Max depth 5** (not 15) — the selected element is already the right scope
2. **Also produces `selectorPath`** — the ancestor chain from the selected element up to `<body>`

**Selector path construction:**

```
document.body
    └── div#main
            └── section.sidebar
                    └── article          ← selected element
                            └── ...

selectorPath = "div#main > section > article"
               (each ancestor: tag + #id if present)
```

This gives the LLM positional context without sending the full page tree.

---

## Step-by-step: what happens to a real element

Take this real DOM fragment:

```html
<nav id="TopNav" class="site-header" role="navigation">
  <style>.nav { color: red }</style>
  <div class="nav-content" data-testid="top-bar">
    <a href="/" aria-label="Home" onclick="track()">
      <svg>...</svg>
      Reddit
    </a>
    <input type="search" placeholder="Search Reddit" name="q">
    <script>analytics()</script>
  </div>
</nav>
```

**Step 1 — Enter `<nav>`:**
Tag is `nav`, not in SKIP. Collect: `id="TopNav"`, `class="site-header"`, `role="navigation"`. Recurse into children.

**Step 2 — Enter `<style>`:**
Tag is `style` → in SKIP → return `''`. Pruned entirely.

**Step 3 — Enter `<div>`:**
Collect: `class="nav-content"`, `data-testid="top-bar"`. Recurse.

**Step 4 — Enter `<a>`:**
Collect: `aria-label="Home"`. (No `id`, no `class`, no `data-testid`.) `onclick` is not in the whitelist — dropped. Text node "Reddit" is not an Element — skipped. Recurse into children.

**Step 5 — Enter `<svg>`:**
Tag is `svg` → in SKIP → return `''`.

**Step 6 — Enter `<input>`:**
Collect: `type="search"`, `placeholder="Search Reddit"`, `name="q"`. No children.

**Step 7 — Enter `<script>`:**
Tag is `script` → in SKIP → return `''`.

**Result:**

```html
<nav id="TopNav" class="site-header" role="navigation">
  <div class="nav-content" data-testid="top-bar">
    <a aria-label="Home"></a>
    <input type="search" placeholder="Search Reddit" name="q">
  </div>
</nav>
```

**Token reduction on this fragment:** ~500 chars → ~120 chars (~75% reduction). On a full Reddit page, raw HTML is ~1.5MB; the skeleton is ~60KB (~15K tokens).

---

## Full data flow

```
                     "Apply to page"
                     ┌─────────────────────────────────────────────┐
                     │                                             │
popup.js ──APPLY_TWEAK──► background.js                           │
                         │                                         │
                         ├─ executeScript(simplify, depth≤15) ──► page context
                         │       └─ returns skeleton string        │
                         │                                         │
                         ├─ buildUserContent(skeleton, prompt) ◄───┘
                         │       "Page URL: ...\nPage DOM:\n<html>...\n\nUser request: ..."
                         │
                         └─► LLM API ──► parseResponse() ──► injectTweak()


                     "Select region"
                     ┌─────────────────────────────────────────────┐
                     │                                             │
popup.js ──START_PICKER──► background.js ──START_PICKER──► content.js
                                                                   │
                                         user clicks element       │
                                                                   │
                         background.js ◄──ELEMENT_SELECTED─────────┘
                         │   { simplifiedHTML, selectorPath }
                         │
                         ├─ buildUserContent(null, prompt, elementContext)
                         │       "Target element (user-selected):\nSelector path: div > section > article\n<article ...>...</article>\n\nUser request: ..."
                         │
                         └─► LLM API ──► parseResponse() ──► injectTweak()
```

---

## Why this design wins on the tradeoff

| Property | Raw HTML | This skeleton |
|---|---|---|
| Token cost (Reddit) | ~375K tokens | ~15K tokens |
| LLM selector accuracy | Low (noise dominates) | High (only signal) |
| Text content leaked | Yes | No |
| Inline style leaked | Yes | No |
| SVG noise | Yes | No |
| Structural fidelity for selectors | Full | Full (all id/class/role preserved) |

The key insight: **CSS and JS selectors only care about tag names, IDs, classes, ARIA roles, and data attributes.** Everything else — text, styles, event handlers, SVG paths — is irrelevant to the LLM's task and actively harmful to accuracy by inflating context.

---

## One known sharp edge

The depth cap (15 for full-page, 5 for picker) is a hard cutoff. Very deeply nested components — common in React/Angular apps with many wrapper `div`s — may have their leaf elements pruned. The LLM then has to infer selectors from what's visible in the skeleton, which occasionally produces selectors that target a container instead of the intended leaf. The "Select region" path mitigates this because it starts the depth count from the user's chosen element, not the document root.

# DOM Extraction Algorithm — State of the World

## Current algorithm

The extension uses a `simplify(node, depth)` recursive function that walks the live DOM and produces a compact HTML skeleton. It runs via `chrome.scripting.executeScript` so it has direct DOM access inside the page context. There are three separate extraction paths:

| Path | Where | Depth cap | Scope |
|---|---|---|---|
| Apply to page | `background.js handleApplyTweak` | 20 | `document.documentElement` |
| Extract button | `popup.js extractDOM` | 20 | `document.documentElement` |
| Select region | `content.js extractElement` | 5 | User-selected element |

### What the algorithm does

**Tag filtering** — Skips `script`, `style`, `svg`, `noscript`, `head` entirely, including all their descendants.

**Visibility filtering** — Skips nodes where `node.hidden`, `aria-hidden="true"`, `style.display === "none"`, or `style.visibility === "hidden"`. Ensures LLM only sees elements the user can actually see and target.

**Wrapper collapsing** — If a node has exactly one element child, no `id`, no `className`, no `role`, and is not a landmark tag (`main`, `article`, `section`, etc.), the algorithm recurses into the child without incrementing depth. This lets the effective reach extend past the hard depth cap through anonymous wrapper `div` chains common in React/Angular apps.

**Attribute whitelist** — Only serializes: `id`, `class`, `aria-label`, `data-testid`, `role`, `name`, `type`, `slot`, `placeholder`. Everything else (event handlers, `style`, `data-*`, etc.) is dropped.

**Class pruning** — Two regexes strip noisy classes before serialization:
- `UTILITY_RE`: Tailwind/utility prefixes (`px-`, `text-`, `bg-`, `flex`, `grid`, etc.)
- `GENERATED_RE`: Hashed/generated names from styled-components (`sc-*`), Emotion (`css-*`), and CSS Modules (`_name_hash_N`)
- Fallback: if all classes are pruned, keeps the first two originals so the element is never classless.

**Text hints** — First 40 characters of direct text nodes (not descendants) are emitted as `data-text="..."`. This lets the LLM identify elements by visible label without the text inflating the structural tree. The system prompt explicitly warns the LLM never to use `data-text` in generated selectors.

**Additional identification signals** — `href` (≤60 chars) on `<a>`, `alt` (≤40 chars) on `<img>`, `aria-expanded/selected/checked/current`, `title`, form `value`/`for`/`action`.

**Structural deduplication** — After building child skeletons, consecutive siblings are compared after normalizing dynamic values (`data-text`, `href`, `alt` zeroed out). Runs of 3+ structurally identical siblings collapse to the first plus `<!-- +N similar -->`. This handles feed pages (Reddit, Twitter) where 50 identical post skeletons would otherwise dominate the output.

**Landmark comments** — `<main>`, `<nav>`, `<header>`, `<footer>`, `<aside>` are preceded by `<!-- MAIN CONTENT -->` etc., giving the LLM spatial orientation without requiring it to infer structure from class names.

### Select region differences

`content.js extractElement` is a much simpler version. It has no text hints, no class pruning, no deduplication, no wrapper collapsing, no visibility filtering, and no additional attributes beyond the core whitelist. It also produces a `selectorPath` — the ancestor chain from the selected element to `<body>` using `tag#id` notation — which gives the LLM positional context without the full page tree.

### Token budget (current)

| Path | Typical input tokens |
|---|---|
| Apply to page (Reddit) | ~6,000–9,000 |
| Apply to page (simple page) | ~1,000–3,000 |
| Select region | ~75–200 |

---

## What worked well

**Deduplication** is the single biggest win on feed-based sites. Reddit, Twitter, and similar pages have 20–50 structurally identical post cards. Before deduplication these dominated the skeleton; now they collapse to one example plus a comment. Normalizing `data-text`/`href`/`alt` before comparison was important — without it, posts with different titles would not be recognized as duplicates.

**Text hints** directly solved the most common LLM failure mode: "hide the Settings button" when there is no `id` or unique class on the button. The `data-text` attribute gives the LLM the visible label it needs to locate the element, and keeping it as a non-standard attribute (rather than text content) signals that it should not appear in generated selectors.

**Wrapper collapsing** meaningfully extends the effective depth on React/Angular apps without raising the token cost. Anonymous `div > div > div` chains that exist only for layout get transparently passed through, and the depth counter only increments for nodes that carry identifying information.

**Class pruning** significantly reduces token noise on Tailwind-heavy sites where every element has 15–20 utility classes. Retaining the fallback (keep first 2 if all pruned) was important — without it, some elements would lose their only class-based selector.

**Visibility filtering** prevents the LLM from targeting hidden elements. Before this, the LLM would sometimes generate selectors for `display:none` elements that matched the user's description but were not the visible instance.

**Select region path** is dramatically more efficient. At 75–200 tokens vs 6–9K for full-page, it costs ~40–100x less per call and produces more precise output because the LLM sees only the relevant subtree. The `selectorPath` gives enough positional context to write correct selectors even though the full page is not provided.

---

## What did not work

**Code is duplicated across three files.** The full-page simplify function exists verbatim in `background.js` and `popup.js`. The element picker in `content.js` is a stripped-down third copy. `domUtils.js` was created as a shared utility module but is untracked and never loaded — the manifest does not include it and no file references it. Keeping three copies in sync is error-prone.

**`content.js extractElement` never received the Smart Skeleton upgrades.** The element picker still uses the original basic algorithm with no text hints, no class pruning, no wrapper collapsing, and no deduplication. These would all help — especially text hints, which are arguably more valuable at the element level where the LLM needs to write very precise selectors.

**Class pruning regex is heuristic and over-prunes.** `GENERATED_RE` includes `[a-z]{1,2}[A-Z][a-zA-Z]{3,}` to catch styled-components mangled names, but this pattern also matches intentional camelCase class names like `pageTitle`, `navItem`, or `userCard`. The result is that on some sites, meaningful semantic classes get dropped and the LLM is left with fewer identification signals.

**Deduplication threshold of 3 is arbitrary.** Two identical siblings do not trigger deduplication. On some pages (sidebars with paired widgets, two-column layouts) this means moderately repetitive content is fully serialized when collapsing it would be fine.

**The hard depth cap (20) still prunes some leaf nodes.** With wrapper collapsing this is much less common, but deeply nested components in large SPAs can still hit the cap. The LLM then has to target a container element instead of the actual leaf, producing selectors that are too broad.

**SVG is skipped entirely.** This is correct for icon-heavy sites where SVGs are purely decorative, but some UIs use SVG-based interactive elements (custom chart controls, SVG buttons). These are invisible to the LLM.

**Console log context mismatch.** Logs emitted from inside `executeScript` run in the page's isolated world and appear in the tab's DevTools console, not the service worker console. The apply flow logs (in `background.js buildUserContent`) appear in the service worker console. These are two different DevTools windows, so observing all logs requires monitoring two separate consoles. Worked around by routing popup-side logs through a `LOG` message to the background service worker.

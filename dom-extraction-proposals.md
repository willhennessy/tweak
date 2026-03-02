# DOM Extraction Optimization — Three Proposals

**Author:** Staff Engineering
**Status:** Proposal
**Context:** Tweak Chrome extension — consumer websites (Reddit, Facebook, ESPN, Gmail, news sites)

---

## Problem Statement

The current DOM extraction algorithm (`simplify`) produces a structural skeleton that strips text, styles, and non-identifying attributes. This yields ~15,000 tokens for a complex page like Reddit (down from ~375K raw) but has known weaknesses that limit the LLM's ability to correctly identify and target DOM elements.

**Current success rate estimate:** ~60–70% for full-page "Apply to page" tweaks.

### Known Weaknesses

| # | Weakness | Impact |
|---|----------|--------|
| 1 | **Depth cutoff at 15** | React/Angular apps nest 20-30 wrapper divs. Leaf elements the user actually wants get pruned. |
| 2 | **No text content** | User says "hide the Settings button" — LLM can't find it because text is stripped. |
| 3 | **No deduplication** | 50 identical `<div class="comment">` nodes all serialize. LLM only needs to see the pattern once. |
| 4 | **Class bloat** | Tailwind utilities like `px-4 py-2 text-sm font-medium bg-white border...` inflate tokens without helping identification. |
| 5 | **No structural hints** | LLM can't distinguish sidebar from main content from footer without inferring from class names. |
| 6 | **Missing href/src** | Links and images lose their URLs, removing a signal the LLM could use for identification. |

---

## Approach 1: "Smart Skeleton" — Enhanced Static Extraction

### Summary

Evolve the current `simplify()` function to address all six weaknesses without adding any extra API calls. Same architecture, richer output, fewer wasted tokens.

### Technical Design

#### 1. Text Content Hints (solves weakness #2)

For each element, capture the first 40 characters of its **direct** text content (not descendants) and emit it as a synthetic `data-text` attribute. The LLM uses this to identify elements by visible label but never targets `data-text` in selectors.

```js
const directText = Array.from(node.childNodes)
  .filter(n => n.nodeType === 3)
  .map(n => n.textContent.trim())
  .join(' ')
  .slice(0, 40);
const textAttr = directText ? ` data-text="${directText}"` : '';
```

Cost: ~5–10 tokens per element with text. Most deep wrapper divs have none, so this is cheap.

#### 2. Semantic Deduplication (solves weakness #3)

After building the skeleton string for each child, detect runs of 3+ consecutive siblings with identical skeletons. Keep the first, replace the rest with `<!-- +N similar -->`.

```js
function deduplicateChildren(childOutputs) {
  const result = [];
  let i = 0;
  while (i < childOutputs.length) {
    let j = i + 1;
    while (j < childOutputs.length && childOutputs[j] === childOutputs[i]) j++;
    result.push(childOutputs[i]);
    if (j - i - 1 >= 2) result.push(`<!-- +${j - i - 1} similar -->`);
    i = j;
  }
  return result;
}
```

On Reddit's feed: 50 identical `<shreddit-post>` skeletons collapse to 1 + `<!-- +49 similar -->`.

#### 3. Adaptive Depth with Wrapper Collapsing (solves weakness #1)

Detect "wrapper" nodes — elements with exactly one element child and no identifying attributes. Recurse through them without incrementing the depth counter.

```js
function isWrapper(node) {
  if (Array.from(node.children).length !== 1) return false;
  const tag = node.tagName.toLowerCase();
  if (['main','article','section','nav','header','footer','aside'].includes(tag)) return false;
  return !node.id && !node.className && !node.getAttribute('role');
}
```

Raise the hard cap from 15 → 20, but with wrapper collapsing the effective reach extends to ~25–30 real levels without token increase.

#### 4. Class Pruning (solves weakness #4)

Strip Tailwind/utility classes that match common patterns. Keep only classes that look like component identifiers:

```js
const UTILITY_RE = /^(p[xytblr]?|m[xytblr]?|w-|h-|min-|max-|text-|font-|bg-|border|rounded|shadow|flex|grid|gap-|space-|leading-|tracking-|opacity-|overflow-|z-|absolute|relative|fixed|sticky|block|inline|hidden|transition|duration|cursor|transform|rotate|scale|translate|animate)-?\d*/;

function pruneClasses(classStr) {
  const kept = classStr.split(/\s+/).filter(c => !UTILITY_RE.test(c));
  return kept.length > 0 ? kept.join(' ') : classStr.split(/\s+/).slice(0, 2).join(' ');
}
```

Fallback keeps first 2 classes if all are utilities, so the element is never classless.

#### 5. Additional Identifying Attributes (solves weakness #6)

```js
if (tag === 'a') {
  const href = node.getAttribute('href');
  if (href) attrs += ` href="${href.slice(0, 60)}"`;
}
if (tag === 'img') {
  const alt = node.getAttribute('alt');
  if (alt) attrs += ` alt="${alt.slice(0, 40)}"`;
}
```

#### 6. Structural Landmark Comments (solves weakness #5)

For HTML5 landmark elements and ARIA landmarks, prepend a comment:

```js
const LANDMARKS = {
  main: 'MAIN CONTENT', nav: 'NAVIGATION', header: 'HEADER',
  footer: 'FOOTER', aside: 'SIDEBAR'
};
const comment = LANDMARKS[tag] ? `\n<!-- ${LANDMARKS[tag]} -->\n` : '';
```

### Example Output (Reddit-like page)

```html
<html>
<!-- HEADER -->
<header id="TopNav" class="site-header" role="navigation">
  <div class="nav-content" data-testid="top-bar">
    <a aria-label="Home" href="/" data-text="Reddit"></a>
    <input type="search" placeholder="Search Reddit" name="q">
    <button data-text="Log In" class="login-btn"></button>
  </div>
</header>
<div id="AppRouter">
  <!-- MAIN CONTENT -->
  <main>
    <shreddit-feed>
      <shreddit-post id="t3_abc123" class="Post" data-testid="post-container">
        <div class="post-header">
          <a class="subreddit-link" href="/r/programming" data-text="r/programming"></a>
          <span class="author" data-text="u/someone"></span>
        </div>
        <div class="post-title" data-text="Why Rust is eating the wo..."></div>
        <div class="post-actions">
          <button class="upvote" aria-label="upvote"></button>
          <button class="downvote" aria-label="downvote"></button>
          <a class="comments" data-text="342 comments"></a>
        </div>
      </shreddit-post>
      <!-- +24 similar -->
    </shreddit-feed>
  </main>
  <!-- SIDEBAR -->
  <aside class="sidebar">
    <div class="community-info" data-text="r/programming"></div>
    <div class="rules-widget" data-text="Community Rules"></div>
  </aside>
</div>
<!-- FOOTER -->
<footer class="site-footer" data-text="Reddit Inc. 2026"></footer>
</html>
```

### Token Budget

| Change | Token impact |
|--------|-------------|
| Text hints | +2,000 |
| Deduplication | -5,000 to -8,000 |
| Wrapper collapsing | -1,000 to -2,000 |
| Class pruning | -1,500 to -3,000 |
| Landmark comments | +200 |
| href/alt attrs | +500 |
| **Net total** | **~6,000–9,000 tokens** (40–60% reduction from current ~15K) |

### Pros

- Zero additional API calls — same latency as today
- Backward compatible with existing system prompt
- Deduplication alone is a massive win on feed-based sites (Reddit, Twitter, Facebook)
- Text hints directly solve the "hide the Settings button" class of failures
- Class pruning helps significantly on Tailwind-heavy modern sites

### Cons

- Utility class regex is heuristic — may accidentally prune a meaningful class on rare sites
- Deduplication only works for consecutive identical siblings; interleaved ads or promoted posts break the run
- Wrapper collapsing may occasionally skip a structurally significant container
- Still sends the entire page tree — no awareness of user intent
- Doesn't solve the fundamental problem of the LLM searching a large tree for a small target

### Implementation Complexity: **Low–medium**

~80–100 lines of new code. All changes are within the `simplify` function and a new `deduplicateChildren` helper. No new message types, permissions, or API calls.

### Expected Success Rate: **~80–85%** (up from ~60–70%)

Text hints eliminate the "can't find element by label" category. Deduplication improves signal-to-noise ratio. Wrapper collapsing exposes leaf nodes that were previously depth-pruned.

---

## Approach 2: "Two-Pass Agentic" — LLM-Assisted Extraction

### Summary

Use a cheap, fast first LLM call to identify the relevant DOM subtree, then extract only that subtree at high depth and send it to the main LLM for CSS/JS generation. The first pass acts as an intelligent DOM search engine.

### Architecture

```
User prompt: "Hide the trending sidebar"
         │
         ▼
┌─────────────────────────────────┐
│  Pass 1: LOCATOR                │
│  Model: Haiku / GPT-4o-mini    │
│  Input: Smart Skeleton (~7K)   │
│  Task: "Return CSS selectors   │
│   for the relevant region"     │
│  Output: ["aside.sidebar",     │
│   "div[data-testid='trending']"]│
└────────────┬────────────────────┘
             │
             ▼
┌─────────────────────────────────┐
│  DOM Re-extraction              │
│  executeScript with selectors   │
│  Depth limit: 25               │
│  Includes: full text, href,    │
│   src, computed dimensions     │
└────────────┬────────────────────┘
             │
             ▼
┌─────────────────────────────────┐
│  Pass 2: GENERATOR              │
│  Model: Sonnet / GPT-4o        │
│  Input: Focused subtree (~1K)  │
│  Task: Produce { type, code }  │
│  Output: CSS or JS             │
└─────────────────────────────────┘
```

### Pass 1: The Locator

A new `callLocatorAPI` function sends a Smart Skeleton (Approach 1 output) to a cheap model with a focused system prompt:

```
You are a DOM analysis expert. Given a page skeleton and user request,
identify which DOM elements are relevant.

Return a JSON array of CSS selectors that match the relevant region(s):
["selector1", "selector2"]

Rules:
- Use selectors visible in the skeleton (IDs, classes, tag names, attributes)
- Return 1-3 selectors, most specific first
- Use data-text attributes to locate elements by visible text
- No prose, just the JSON array
```

### Pass 2: Deep Focused Extraction

A second `executeScript` call takes the locator's selectors and extracts a rich, deep subtree:

- Depth limit **25** (narrow scope = fewer total nodes even at high depth)
- Full text content (not truncated — subtree is small enough)
- All `data-*` attributes (useful at this scope)
- `href`, `src`, `alt`, `for`, `action`, `value`
- Computed `display` and `getBoundingClientRect()` for layout context
- Still skips `script`, `style`, `svg`

If the locator returns no valid selectors or `querySelector` finds nothing, **fall back** to single-pass Smart Skeleton.

### Example (Reddit, "Make upvote/downvote buttons bigger")

**Pass 1 output** (Haiku, ~300ms):
```json
["shreddit-post .post-actions", "button.upvote", "button.downvote"]
```

**Focused DOM sent to Pass 2** (~800 tokens):
```html
<!-- Matched: shreddit-post .post-actions -->
<!-- Context: inside <shreddit-post> within <shreddit-feed> in <main> -->
<!-- Dimensions: 400x36px, display: flex -->
<div class="post-actions">
  <button class="upvote" aria-label="upvote" role="button">
    <span class="icon-container">
      <svg-icon name="upvote"></svg-icon>
    </span>
    <span data-text="1.2k"></span>
  </button>
  <button class="downvote" aria-label="downvote" role="button">
    <span class="icon-container">
      <svg-icon name="downvote"></svg-icon>
    </span>
  </button>
  <a class="comments" href="/r/programming/comments/abc123" data-text="342 comments"></a>
  <button class="share" data-text="Share"></button>
</div>
```

**Pass 2 output** (Sonnet):
```json
{ "type": "css", "code": "button.upvote, button.downvote { transform: scale(1.5) !important; padding: 8px !important; }" }
```

### Cost Analysis

| Component | Tokens | Model | Cost |
|-----------|--------|-------|------|
| Pass 1 input | ~7,000 | Haiku | ~$0.0007 |
| Pass 1 output | ~50 | Haiku | negligible |
| Pass 2 input | ~500–2,000 | Sonnet | ~$0.003–0.006 |
| Pass 2 output | ~100 | Sonnet | negligible |
| **Total** | | | **~$0.004–0.008** |

Current single-pass cost: ~$0.045 (Sonnet at 15K tokens). **The two-pass approach is 6–10x cheaper** because the expensive model sees far fewer tokens.

### Latency

| Step | Time |
|------|------|
| Pass 1 (Haiku) | ~300–500ms |
| DOM re-extraction | ~50ms |
| Pass 2 (Sonnet, small input) | ~500–1,000ms |
| **Total** | **~1,000–1,500ms** |

Current single-pass: ~1,500–2,500ms. Net latency is **roughly the same or faster** because Pass 2 completes quicker on smaller input.

### Pros

- Dramatically reduces expensive-model token usage (saves money)
- Generator sees only relevant context — higher accuracy for targeted changes
- Deep extraction (depth 25) reaches leaf nodes that depth-15 misses
- Full text content included without exploding token count
- The locator step handles ambiguity — LLM reasons about which region the user means
- Actually cheaper than the current single-pass approach

### Cons

- Two API calls = two points of failure; locator can return wrong selectors
- New prompt engineering surface: locator prompt must be tuned carefully
- If locator returns wrong selectors, Pass 2 generates correct CSS for the wrong element — a subtle failure mode that's harder to debug than "no match found"
- More complex error handling: Pass 1 succeeds but Pass 2 fails, or locator returns selectors that don't exist in the DOM
- Requires a fallback path (single-pass Smart Skeleton) for when the locator fails
- Users may not want to pay for two API calls even if it's cheaper overall (psychological friction)

### Implementation Complexity: **Medium–high**

~120 lines of new code. New `callLocatorAPI` function, new `deepSimplify` extraction function, modified `handleApplyTweak` to orchestrate two passes, fallback logic, and potentially a user-facing toggle in options.

### Expected Success Rate: **~85–90%** (up from ~60–70%)

The focused subtree gives the generator precise context. Deep extraction solves the depth-cutoff problem entirely for the matched region. The main failure mode shifts from "LLM couldn't find the element" (common) to "locator identified the wrong region" (less common).

---

## Approach 3: "Hybrid Landmark" — Semantic Zone Extraction

### Summary

Segment the page into semantic zones on the client side (header, nav, main, sidebar, footer, modal, etc.), then use keyword matching against the user's prompt to send only the relevant zone(s) to the LLM. No extra API call, but smarter about what portion of the page to serialize.

### Architecture

```
User prompt: "Hide the trending sidebar"
         │
         ▼
┌─────────────────────────────────┐
│  Phase 1: ZONE DETECTION        │
│  Walk top-level DOM (depth 3-4) │
│  Classify each subtree:         │
│    header, nav, main, sidebar,  │
│    footer, modal, comments,     │
│    form, toolbar, ads           │
│  Using: tag, role, class, id,   │
│    aria-label, position heuristics│
└────────────┬────────────────────┘
             │
             ▼
┌─────────────────────────────────┐
│  Phase 2: ZONE SELECTION        │
│  Match prompt keywords to zones │
│  "sidebar" → sidebar zone       │
│  "trending" → sidebar zone      │
│  Score and pick top 1-2 zones   │
└────────────┬────────────────────┘
             │
             ▼
┌─────────────────────────────────┐
│  Phase 3: DEEP EXTRACTION       │
│  Smart Skeleton (Approach 1)    │
│  only within matched zones      │
│  Depth limit: 20               │
│  + depth-2 page overview        │
└────────────┬────────────────────┘
             │
             ▼
┌─────────────────────────────────┐
│  LLM CALL                       │
│  Input: page overview + zones   │
│  Same single API call as today  │
└─────────────────────────────────┘
```

### Zone Detection

Classify DOM subtrees using a signal-scoring heuristic that examines tag name, `role`, `class`, `id`, `aria-label`, and `data-testid`:

```js
function classifyZone(el) {
  const signals = [
    el.tagName.toLowerCase(),
    el.getAttribute('role') || '',
    (el.className || '').toLowerCase(),
    (el.id || '').toLowerCase(),
    (el.getAttribute('aria-label') || '').toLowerCase(),
  ].join(' ');

  const patterns = {
    header:     /header|topnav|masthead|app-bar|banner/,
    navigation: /nav|menu|sidebar-nav|breadcrumb|tabs/,
    main:       /main|feed|content|stream|timeline|article/,
    sidebar:    /sidebar|aside|rail|widget|trending|popular/,
    footer:     /footer|bottom-bar|copyright/,
    modal:      /modal|dialog|overlay|popup|drawer/,
    comments:   /comment|reply|thread|discussion/,
    form:       /form|login|signup|register|search|compose/,
  };

  for (const [zone, re] of Object.entries(patterns)) {
    if (re.test(signals)) return zone;
  }

  // Positional fallback
  const rect = el.getBoundingClientRect();
  if (rect.top < 80 && rect.width > innerWidth * 0.8) return 'header';
  if (rect.bottom > document.documentElement.scrollHeight - 100) return 'footer';
  if (rect.width < innerWidth * 0.3 && rect.height > 200) return 'sidebar';

  return 'unknown';
}
```

### Prompt-Based Zone Selection

Match user prompt keywords against zone names and the first 100 characters of each zone's visible text:

```js
const ZONE_KEYWORDS = {
  header:     ['header', 'top', 'navbar', 'logo', 'banner'],
  navigation: ['nav', 'menu', 'link', 'breadcrumb', 'tab'],
  main:       ['post', 'article', 'content', 'feed', 'card', 'main', 'story'],
  sidebar:    ['sidebar', 'side', 'widget', 'trending', 'popular', 'right'],
  footer:     ['footer', 'bottom', 'copyright'],
  modal:      ['modal', 'popup', 'dialog', 'overlay', 'banner', 'cookie'],
  comments:   ['comment', 'reply', 'thread', 'discussion'],
  form:       ['form', 'login', 'sign', 'input', 'button', 'submit', 'search'],
};
```

If no zone scores above threshold, fall back to sending all zones at reduced depth (Smart Skeleton full-page).

### Output Format

The LLM always receives:
1. A **depth-2 page overview** (~300 tokens) for global orientation
2. **Deep extraction of matched zone(s)** with all Approach 1 enhancements

```
Page URL: https://www.reddit.com/
Zones detected: header, main, sidebar, footer
Matched zones for your request: sidebar

<!-- PAGE STRUCTURE (depth 2) -->
<html>
<body>
  <header id="TopNav">...</header>
  <div id="AppRouter"><main>...</main><aside>...</aside></div>
  <footer>...</footer>
</body>
</html>

<!-- ZONE: SIDEBAR -->
<aside class="sidebar" role="complementary">
  <div class="community-info" data-testid="community-info">
    <h2 data-text="About r/programming"></h2>
    <div class="member-count" data-text="6.2M members"></div>
    <button class="join-btn" data-text="Join"></button>
  </div>
  <div class="trending" data-testid="trending-widget">
    <h3 data-text="Trending today"></h3>
    <ul class="trending-list">
      <li class="trending-item">
        <a href="/r/technology/comments/xyz" data-text="Apple announces..."></a>
        <span data-text="15.2k upvotes"></span>
      </li>
      <!-- +4 similar -->
    </ul>
  </div>
  <div class="rules-widget" data-testid="rules-widget">
    <h3 data-text="r/programming Rules"></h3>
    <ol class="rules-list">
      <li data-text="1. No memes"></li>
      <!-- +5 similar -->
    </ol>
  </div>
</aside>

User request: Hide the trending sidebar
```

### Token Budget

| Scenario | Tokens | vs. Current |
|----------|--------|-------------|
| Targeted request (1 zone) | ~1,000–1,500 | **90–93% reduction** |
| Multi-zone request | ~5,000–8,000 | 35–50% reduction |
| Fallback (no zone match) | ~6,000–9,000 | 40–60% reduction (Approach 1) |

### Pros

- Massive token savings for targeted requests, which are the majority ("hide X", "change Y in the sidebar")
- No extra API calls — same latency as today, plus ~50ms for the two-phase `executeScript`
- Deep extraction within zones (depth 20) solves the depth-cutoff problem
- Zone labels give the LLM explicit spatial context — eliminates "confused sidebar with main content" errors
- Graceful fallback to Smart Skeleton full-page when zone matching fails
- The depth-2 overview always gives the LLM the full picture for orientation
- Composes naturally with Approach 1 — uses Smart Skeleton as the extraction algorithm within each zone

### Cons

- Zone classification is heuristic — will misclassify on unusual page layouts (SPAs, canvas-heavy apps, unconventional markup)
- Keyword matching is fragile: "hide that thing on the right" won't match "sidebar" without expanding the keyword set significantly
- Some requests span zones: "swap the sidebar and main content" needs both fully serialized
- Custom web components (`<shreddit-feed>`, `<gpt-card>`) may not be classifiable by tag/class patterns
- If zone detection fails, falls back to full-page — user gets no benefit from the added complexity on that request
- Architectural change: currently DOM extraction has no knowledge of the user's prompt. This approach requires passing the prompt into the extraction step, or doing zone selection in the service worker with a second `executeScript` round-trip

### Implementation Complexity: **Medium**

~120 lines of new code. `classifyZone`, `buildZoneMap`, `selectZones`, `extractZones` functions inside the `executeScript` callback. Modified `handleApplyTweak` to pass prompt into extraction (or two-phase script execution). Updated `SYSTEM_PROMPT` to explain zone annotations.

### Expected Success Rate: **~82–88%** (up from ~60–70%)

For zone-targeted requests (~70% of prompts), the LLM sees deep, text-rich context of exactly the right region. Zone labels eliminate a whole class of "targeted wrong region" errors. For full-page requests, falls back to Approach 1 improvements.

---

## Comparative Summary

| Dimension | Smart Skeleton | Two-Pass Agentic | Hybrid Landmark |
|---|---|---|---|
| Tokens (targeted) | ~6–9K | ~1–2K (expensive model) | ~1–1.5K |
| Tokens (full-page) | ~6–9K | ~7K + ~1–2K | ~5–8K |
| API calls | 1 | 2 | 1 |
| Added latency | 0 | ~300–500ms | ~50ms |
| Cost per tweak | ~$0.020 | ~$0.004–0.008 | ~$0.003–0.024 |
| Complexity | Low–medium | Medium–high | Medium |
| Success rate | ~80–85% | ~85–90% | ~82–88% |
| Primary failure mode | Depth cutoff on extreme nesting | Locator returns wrong selectors | Zone misclassification |
| Best for | General improvement across all requests | Precise, targeted element changes | Spatially-described changes ("in the sidebar") |

### Composition Strategy

These approaches are not mutually exclusive. They layer naturally:

```
Layer 0 (current):  simplify() with hard depth cap, no text, no dedup
Layer 1 (Skeleton): Add text hints, dedup, wrapper collapsing, class pruning
Layer 2 (Landmark): Use Layer 1 as extraction within semantic zones
Layer 3 (Agentic):  Use Layer 1 or 2 as input to locator pass
```

**Recommended implementation order:**

1. **Start with Approach 1** (Smart Skeleton) — it improves everything, is lowest risk, and becomes the foundation for the other two.
2. **Layer Approach 3** (Hybrid Landmark) on top — zone detection calls Smart Skeleton within each zone. Biggest token savings for targeted requests.
3. **Add Approach 2** (Two-Pass Agentic) as an optional mode — highest ceiling but most complex. Consider it once Approaches 1+3 are validated in production.

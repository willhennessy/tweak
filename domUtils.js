// domUtils.js — content script that defines tweakSimplifyDOM() in the isolated world.
// Called via executeScript({ func: () => tweakSimplifyDOM() }) from background.js and popup.js.
function tweakSimplifyDOM() {
  const SKIP = new Set(["script", "style", "svg", "noscript", "head"]);
  const ID_ATTRS = [
    "id", "class", "aria-label", "data-testid", "role",
    "name", "type", "slot", "placeholder",
  ];
  const LANDMARKS = {
    main: "MAIN CONTENT", nav: "NAVIGATION", header: "HEADER",
    footer: "FOOTER", aside: "SIDEBAR",
  };
  const WRAPPER_SKIP_TAGS = new Set([
    "main", "article", "section", "nav", "header", "footer", "aside",
  ]);
  // Matches Tailwind/utility class prefixes — pruned to reduce token noise.
  const UTILITY_RE = /^(p[xytblr]?|m[xytblr]?|w-|h-|min-|max-|text-|font-|bg-|border|rounded|shadow|flex|grid|gap-|space-|leading-|tracking-|opacity-|overflow-|z-|absolute|relative|fixed|sticky|block|inline|hidden|transition|duration|cursor|transform|rotate|scale|translate|animate)-?\d*/;
  // Matches generated/hashed class names: styled-components, Emotion, CSS Modules.
  const GENERATED_RE = /^(sc-[a-zA-Z0-9]+|css-[a-zA-Z0-9]+|[a-z]{1,2}[A-Z][a-zA-Z]{3,}|_[a-zA-Z]+_[a-zA-Z0-9]+_\d+)$/;

  function pruneClasses(classStr) {
    const parts = classStr.split(/\s+/);
    const kept = parts.filter(c => !UTILITY_RE.test(c) && !GENERATED_RE.test(c));
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
      while (j < outputs.length && normalizeForDedup(outputs[j]) === normI) j++;
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
    ) return "";

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
      .filter(n => n.nodeType === 3)
      .map(n => n.textContent.trim())
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
      if (alt) attrs += ` alt="${alt.slice(0, 40).replace(/"/g, "&quot;")}"`;
    }

    // Interactive state — helps with dropdowns, tabs, checkboxes, toggles.
    for (const a of ["aria-expanded", "aria-selected", "aria-checked", "aria-current"]) {
      const v = node.getAttribute(a);
      if (v !== null) attrs += ` ${a}="${v}"`;
    }

    // title — tooltip text; crucial for icon-only buttons.
    const title = node.getAttribute("title");
    if (title) attrs += ` title="${title.slice(0, 40).replace(/"/g, "&quot;")}"`;

    // Form attributes — expose current value and label associations.
    if (tag === "input" || tag === "textarea") {
      const val = node.value; // live DOM property, reflects user input
      if (val) attrs += ` value="${val.slice(0, 40).replace(/"/g, "&quot;")}"`;
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
      .map(c => simplify(c, depth + 1))
      .filter(Boolean);
    const children = deduplicateChildren(childOutputs).join("");
    return `${landmark}<${tag}${attrs}>${children}</${tag}>`;
  }

  return simplify(document.documentElement, 0);
}

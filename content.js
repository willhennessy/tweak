const domain = location.hostname;

// Listen for messages from background/popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_TWEAKS") {
    getTweaks().then(sendResponse);
    return true;
  }

  if (message.type === "TOGGLE_TWEAK") {
    toggleTweak(message.id, message.enabled).then(sendResponse);
    return true;
  }

  if (message.type === "DELETE_TWEAK") {
    deleteTweak(message.id).then(sendResponse);
    return true;
  }

  if (message.type === "START_PICKER") {
    startPicker();
    return false;
  }
});

function startPicker() {
  // Inject highlight style using a data attribute to avoid overwriting real ids
  const style = document.createElement('style');
  style.id = 'tweak-picker-style';
  style.textContent = '[data-tweak-highlight] { outline: 2px solid #3b82f6 !important; outline-offset: 2px !important; }';
  document.head.appendChild(style);

  let highlighted = null;

  function onMouseMove(e) {
    if (highlighted && highlighted !== e.target) {
      highlighted.removeAttribute('data-tweak-highlight');
    }
    e.target.setAttribute('data-tweak-highlight', '');
    highlighted = e.target;
  }

  function cleanup() {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeydown);
    if (highlighted) {
      highlighted.removeAttribute('data-tweak-highlight');
      highlighted = null;
    }
    const s = document.getElementById('tweak-picker-style');
    if (s) s.remove();
  }

  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const el = e.target;
    cleanup();
    chrome.runtime.sendMessage({ type: "ELEMENT_SELECTED", ...extractElement(el) });
  }

  function onKeydown(e) {
    if (e.key === 'Escape') {
      cleanup();
    }
  }

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeydown);
}

function extractElement(el) {
  const SKIP = new Set(['script', 'style', 'svg', 'noscript']);
  const ID_ATTRS = ['id', 'class', 'aria-label', 'data-testid', 'role', 'name', 'type', 'slot', 'placeholder'];
  const WRAPPER_SKIP_TAGS = new Set(['main', 'article', 'section', 'nav', 'header', 'footer', 'aside']);
  const UTILITY_RE = /^(p[xytblr]?|m[xytblr]?|w-|h-|min-|max-|text-|font-|bg-|border|rounded|shadow|flex|grid|gap-|space-|leading-|tracking-|opacity-|overflow-|z-|absolute|relative|fixed|sticky|block|inline|hidden|transition|duration|cursor|transform|rotate|scale|translate|animate)-?\d*/;
  const GENERATED_RE = /^(sc-[a-zA-Z0-9]+|css-[a-zA-Z0-9]+|[a-z]{1,2}[A-Z][a-zA-Z]{3,}|_[a-zA-Z]+_[a-zA-Z0-9]+_\d+)$/;

  function pruneClasses(classStr) {
    const parts = classStr.split(/\s+/);
    const kept = parts.filter(c => !UTILITY_RE.test(c) && !GENERATED_RE.test(c));
    return kept.length > 0 ? kept.join(' ') : parts.slice(0, 2).join(' ');
  }

  function isWrapper(node) {
    if (node.children.length !== 1) return false;
    if (WRAPPER_SKIP_TAGS.has(node.tagName.toLowerCase())) return false;
    return !node.id && !node.className && !node.getAttribute('role');
  }

  function normalizeForDedup(s) {
    return s
      .replace(/data-text="[^"]*"/g, 'data-text=""')
      .replace(/href="[^"]*"/g, 'href=""')
      .replace(/alt="[^"]*"/g, 'alt=""');
  }

  function deduplicateChildren(outputs) {
    const result = [];
    let i = 0;
    while (i < outputs.length) {
      const normI = normalizeForDedup(outputs[i]);
      let j = i + 1;
      while (j < outputs.length && normalizeForDedup(outputs[j]) === normI) j++;
      result.push(outputs[i]);
      if (j - i - 1 >= 2) result.push(`<!-- +${j - i - 1} similar -->`);
      i = j;
    }
    return result;
  }

  function simplify(node, depth) {
    if (depth > 5 || node.nodeType !== 1) return '';
    const tag = node.tagName.toLowerCase();
    if (SKIP.has(tag)) return '';

    if (
      node.hidden ||
      node.getAttribute('aria-hidden') === 'true' ||
      node.style.display === 'none' ||
      node.style.visibility === 'hidden'
    ) return '';

    if (isWrapper(node)) return simplify(node.children[0], depth);

    let attrs = ID_ATTRS.map(a => {
      const v = node.getAttribute(a);
      if (!v) return '';
      if (a === 'class') return ` class="${pruneClasses(v)}"`;
      return ` ${a}="${v}"`;
    }).join('');

    const directText = Array.from(node.childNodes)
      .filter(n => n.nodeType === 3)
      .map(n => n.textContent.trim())
      .join(' ')
      .slice(0, 40)
      .replace(/"/g, '&quot;');
    if (directText) attrs += ` data-text="${directText}"`;

    if (tag === 'a') {
      const href = node.getAttribute('href');
      if (href) attrs += ` href="${href.slice(0, 60)}"`;
    } else if (tag === 'img') {
      const alt = node.getAttribute('alt');
      if (alt) attrs += ` alt="${alt.slice(0, 40).replace(/"/g, '&quot;')}"`;
    }

    for (const a of ['aria-expanded', 'aria-selected', 'aria-checked', 'aria-current']) {
      const v = node.getAttribute(a);
      if (v !== null) attrs += ` ${a}="${v}"`;
    }

    const title = node.getAttribute('title');
    if (title) attrs += ` title="${title.slice(0, 40).replace(/"/g, '&quot;')}"`;

    if (tag === 'input' || tag === 'textarea') {
      const val = node.value;
      if (val) attrs += ` value="${val.slice(0, 40).replace(/"/g, '&quot;')}"`;
    }
    if (tag === 'label') {
      const forAttr = node.getAttribute('for');
      if (forAttr) attrs += ` for="${forAttr}"`;
    }
    if (tag === 'form') {
      const action = node.getAttribute('action');
      if (action) attrs += ` action="${action.slice(0, 60)}"`;
    }

    const childOutputs = Array.from(node.children).map(c => simplify(c, depth + 1)).filter(Boolean);
    const children = deduplicateChildren(childOutputs).join('');
    return `<${tag}${attrs}>${children}</${tag}>`;
  }

  const path = [];
  let cur = el;
  while (cur && cur !== document.body) {
    const tag = cur.tagName.toLowerCase();
    const id = cur.id ? `#${cur.id}` : '';
    path.unshift(tag + id);
    cur = cur.parentElement;
  }

  return { simplifiedHTML: simplify(el, 0), selectorPath: path.join(' > ') };
}

async function getTweaks() {
  const { tweaks = {} } = await chrome.storage.local.get("tweaks");
  return tweaks[domain] || [];
}

async function toggleTweak(id, enabled) {
  const { tweaks = {} } = await chrome.storage.local.get("tweaks");
  const domainTweaks = tweaks[domain] || [];
  const tweak = domainTweaks.find((t) => t.id === id);
  if (tweak) {
    tweak.enabled = enabled;
    tweaks[domain] = domainTweaks;
    await chrome.storage.local.set({ tweaks });
  }
  return { success: true };
}

async function deleteTweak(id) {
  const { tweaks = {} } = await chrome.storage.local.get("tweaks");
  const domainTweaks = tweaks[domain] || [];
  tweaks[domain] = domainTweaks.filter((t) => t.id !== id);
  if (tweaks[domain].length === 0) {
    delete tweaks[domain];
  }
  await chrome.storage.local.set({ tweaks });
  return { success: true };
}

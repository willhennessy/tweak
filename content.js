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
  const ID_ATTRS = ['id', 'class', 'aria-label', 'data-testid', 'role', 'name', 'type', 'slot'];

  function simplify(node, depth) {
    if (depth > 5 || node.nodeType !== 1) return '';
    const tag = node.tagName.toLowerCase();
    if (SKIP.has(tag)) return '';
    const attrs = ID_ATTRS.map(a => {
      const v = node.getAttribute(a);
      return v ? ` ${a}="${v}"` : '';
    }).join('');
    const children = Array.from(node.children).map(c => simplify(c, depth + 1)).filter(Boolean).join('');
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

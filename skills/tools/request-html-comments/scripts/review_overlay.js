(() => {
  // Proxied iframe documents also receive this script. Only the visible,
  // top-level page should render controls.
  if (window.top !== window) return;

  // Keep provenance beside the injected UI so the overlay stays portable and
  // forks preserve attribution without requiring configuration.
  const TOOL_INFO = {
    creatorLabel: 'Created by Nick Conn',
    creatorUrl: 'https://x.com/nicholasjconn',
    repositoryUrl: 'https://github.com/nicholasjconn/skills',
  };

  const overlayCss = String.raw`
.steward-review-ui, .steward-review-ui * { box-sizing: border-box; }
#steward-review-root { position: fixed; z-index: 2147483647; top: 22px; left: 50%; display: flex; align-items: center; gap: 5px; min-height: 50px; padding: 6px; color: #f8fafc; background: rgba(15,23,42,.96); border: 1px solid rgba(255,255,255,.18); border-radius: 999px; box-shadow: 0 16px 44px rgba(15,23,42,.28), 0 2px 8px rgba(15,23,42,.18); transform: translateX(-50%); animation: steward-review-enter .18s ease-out; font: 14px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; backdrop-filter: blur(14px); user-select: none; }
#steward-review-root button, .steward-review-popup button { appearance: none; margin: 0; text-transform: none; letter-spacing: normal; white-space: nowrap; }
#steward-review-root button { appearance: none; display: inline-flex; flex: 0 0 auto; align-items: center; justify-content: center; width: auto; min-width: 0; max-width: none; height: 38px; cursor: pointer; margin: 0; border: 0; border-radius: 999px; padding: 0 13px; color: #e2e8f0; background: transparent; transition: background .14s ease, color .14s ease, box-shadow .14s ease, transform .14s ease; font: inherit; font-size: 13px; font-weight: 650; line-height: 1; text-transform: none; letter-spacing: normal; white-space: nowrap; }
#steward-review-root button:hover { color: #fff; background: rgba(255,255,255,.1); }
#steward-review-root button:active { transform: scale(.96); }
#steward-review-root button:focus-visible, .steward-review-popup button:focus-visible { outline: 2px solid #93c5fd; outline-offset: 2px; }
#steward-review-root .sr-drag { width: 28px; cursor: grab; padding: 0; touch-action: none; }
#steward-review-root .sr-drag::before { width: 14px; height: 20px; content: ""; opacity: .82; background-image: radial-gradient(circle, #94a3b8 1.45px, transparent 1.6px); background-position: 0 1px; background-size: 7px 7px; transform: translateY(-1px); }
#steward-review-root .sr-drag:active { cursor: grabbing; }
#steward-review-root .sr-add { gap: 7px; padding-right: 8px; color: #fff; background: #2563eb; }
#steward-review-root .sr-add:hover, #steward-review-root .sr-add[aria-pressed="true"], #steward-review-root .sr-text-toggle:hover, #steward-review-root .sr-text-toggle[aria-pressed="true"] { background: #1d4ed8; }
#steward-review-root .sr-add[aria-pressed="true"], #steward-review-root .sr-text-toggle[aria-pressed="true"] { box-shadow: 0 0 0 3px rgba(96,165,250,.42); }
#steward-review-root .sr-text-toggle { width: 38px; padding: 0; font-family: Georgia,serif; font-size: 17px; font-weight: 700; text-decoration: underline; text-decoration-color: #facc15; text-decoration-thickness: 3px; text-underline-offset: 3px; }
#steward-review-root .sr-plus { display: grid; width: 18px; height: 18px; place-items: center; font-size: 18px; font-weight: 500; line-height: 1; }
#steward-review-root .sr-count { display: grid; min-width: 22px; height: 22px; place-items: center; margin-left: 1px; padding: 0 6px; color: #dbeafe; background: rgba(15,23,42,.28); border: 1px solid rgba(255,255,255,.16); border-radius: 999px; box-shadow: inset 0 1px 0 rgba(255,255,255,.06); font-size: 11px; font-weight: 800; }
#steward-review-root .sr-send { gap: 6px; padding-inline: 12px; }
#steward-review-root .sr-send:hover { color: #fff; background: #15803d; }
#steward-review-root .sr-icon { width: 38px; padding: 0; font-size: 18px; }
#steward-review-root .sr-info { width: 30px; height: 30px; color: #94a3b8; font-family: Georgia,serif; font-size: 14px; font-style: italic; font-weight: 700; opacity: .8; }
#steward-review-root .sr-info:hover { color: #fff; opacity: 1; }
#steward-review-root .sr-info[aria-expanded="true"] { color: #fff; background: rgba(255,255,255,.14); }
#steward-review-root .sr-cancel:hover { color: #fff; background: #b91c1c; }
#steward-review-root .sr-separator { width: 1px; height: 22px; background: rgba(255,255,255,.16); }
#steward-review-root .sr-status { position: absolute; top: calc(100% + 9px); left: 50%; width: max-content; max-width: min(360px, calc(100vw - 24px)); padding: 7px 11px; color: #f8fafc; background: rgba(15,23,42,.94); border: 1px solid rgba(255,255,255,.12); border-radius: 9px; box-shadow: 0 8px 24px rgba(15,23,42,.2); transform: translateX(-50%); animation: steward-review-status .14s ease-out; font-size: 12px; pointer-events: none; }
#steward-review-root .sr-status:empty { display: none; }
.steward-review-pin { position: absolute; z-index: 2147483645; display: grid; width: 31px; height: 31px; cursor: pointer; place-items: center; padding: 0; color: #172554; background: #facc15; border: 2px solid #172554; border-radius: 9px; box-shadow: 0 6px 18px rgba(23,37,84,.28); transform: translate(-50%,-50%); transition: background .14s ease, box-shadow .14s ease, transform .14s ease; animation: steward-review-pin-in .22s cubic-bezier(.2,.8,.2,1.2); font: 800 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
.steward-review-pin:hover, .steward-review-pin:focus-visible { background: #fde047; box-shadow: 0 8px 22px rgba(23,37,84,.34); transform: translate(-50%,-50%) scale(1.08); outline: none; }
.steward-review-highlight { position: absolute; z-index: 2147483644; border-radius: 3px; background: rgba(250,204,21,.42); box-shadow: 0 0 0 1px rgba(202,138,4,.16); pointer-events: none; }
.steward-review-popup { position: fixed; z-index: 2147483646; width: min(350px, calc(100vw - 24px)); padding: 14px; color: #172033; background: #fff; border: 1px solid #cbd5e1; border-radius: 16px; box-shadow: 0 22px 60px rgba(15,23,42,.3), 0 2px 8px rgba(15,23,42,.1); animation: steward-review-popup-in .16s ease-out; font: 14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
.steward-review-popup .sr-popup-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 11px; cursor: grab; touch-action: none; user-select: none; }
.steward-review-popup .sr-popup-head:active { cursor: grabbing; }
.steward-review-popup .sr-kicker { color: #2563eb; font-size: 11px; font-weight: 800; letter-spacing: .07em; text-transform: uppercase; }
.steward-review-popup .sr-popup-title { margin-top: 2px; color: #0f172a; font-size: 15px; font-weight: 750; }
.steward-review-popup .sr-close { width: 28px; height: 28px; cursor: pointer; padding: 0; color: #64748b; background: #f1f5f9; border: 0; border-radius: 999px; font-size: 17px; }
.steward-review-popup .sr-close:hover { color: #0f172a; background: #e2e8f0; }
.steward-review-popup textarea { appearance: none; display: block; width: 100%; min-height: 104px; resize: vertical; margin: 0; padding: 11px 12px; color: #0f172a; background: #fff; border: 1px solid #94a3b8; border-radius: 10px; outline: none; font: inherit; }
.steward-review-popup textarea:focus { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,.16); }
.steward-review-popup .sr-popup-footer { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 10px; }
.steward-review-popup .sr-hint { color: #64748b; font-size: 11px; }
.steward-review-popup .sr-popup-actions { display: flex; gap: 6px; }
.steward-review-popup button { appearance: none; flex: 0 0 auto; width: auto; min-width: 0; max-width: none; height: auto; cursor: pointer; margin: 0; border: 0; border-radius: 8px; padding: 7px 10px; font: inherit; font-size: 12px; font-weight: 700; line-height: 1; text-transform: none; letter-spacing: normal; white-space: nowrap; }
.steward-review-popup .sr-delete { color: #b91c1c; background: #fee2e2; }
.steward-review-popup .sr-delete:hover { background: #fecaca; }
.steward-review-popup .sr-save { color: #fff; background: #2563eb; }
.steward-review-popup .sr-save:hover { background: #1d4ed8; }
.steward-review-popup .sr-save:disabled { cursor: not-allowed; opacity: .45; }
.steward-review-popup .sr-error { min-height: 0; margin-top: 0; color: #b91c1c; font-size: 12px; }
.steward-review-popup .sr-error:not(:empty) { margin-top: 8px; }
.steward-review-info { position: fixed; z-index: 2147483646; display: flex; align-items: center; gap: 4px; width: max-content; max-width: calc(100vw - 24px); padding: 7px; color: #172033; background: #fff; border: 1px solid #cbd5e1; border-radius: 13px; box-shadow: 0 18px 48px rgba(15,23,42,.24), 0 2px 7px rgba(15,23,42,.1); animation: steward-review-popup-in .16s ease-out; font: 13px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
.steward-review-info a { display: inline-flex; align-items: center; justify-content: center; height: 36px; color: #1d4ed8; border-radius: 9px; text-decoration: none; }
.steward-review-info a:hover { background: #eff6ff; }
.steward-review-info a:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }
.steward-review-info .sr-creator { padding: 0 10px; font-weight: 750; white-space: nowrap; }
.steward-review-info .sr-info-divider { width: 1px; height: 22px; background: #e2e8f0; }
.steward-review-info .sr-source { width: 36px; color: #334155; }
.steward-review-info .sr-source:hover { color: #0f172a; }
.steward-review-info .sr-source svg { width: 19px; height: 19px; }
.steward-review-hover { outline: 3px solid #3b82f6 !important; outline-offset: 2px !important; cursor: crosshair !important; }
@keyframes steward-review-enter { from { opacity: 0; transform: translate(-50%,-8px) scale(.97); } to { opacity: 1; transform: translate(-50%,0) scale(1); } }
@keyframes steward-review-status { from { opacity: 0; transform: translate(-50%,-3px); } to { opacity: 1; transform: translate(-50%,0); } }
@keyframes steward-review-popup-in { from { opacity: 0; transform: translateY(-5px) scale(.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
@keyframes steward-review-pin-in { from { opacity: 0; transform: translate(-50%,-50%) scale(.55); } to { opacity: 1; transform: translate(-50%,-50%) scale(1); } }
@media (max-width: 520px) { #steward-review-root .sr-send-label { display: none; } #steward-review-root .sr-send { width: 38px; padding: 0; } .steward-review-popup .sr-hint { display: none; } }
@media (prefers-reduced-motion: reduce) { #steward-review-root, .steward-review-pin, .steward-review-popup, .steward-review-info, #steward-review-root .sr-status { animation: none; transition: none; } }
`;

  // Bootstrap one isolated overlay. The server replaces the two sentinel
  // values below before this script reaches the browser.
  const overlayStyle = document.createElement('style');
  overlayStyle.textContent = overlayCss;
  document.head.appendChild(overlayStyle);
  const endpoint = __ENDPOINT__;
  const root = document.createElement('div');
  root.id = 'steward-review-root';
  root.className = 'steward-review-ui';
  root.innerHTML = `
    <button class="sr-drag" aria-label="Drag toolbar" title="Drag toolbar"></button>
    <button class="sr-add" aria-pressed="false">
      <span class="sr-plus" aria-hidden="true">+</span>
      Comment
      <span class="sr-count" data-count="0" aria-label="0 comments">0</span>
    </button>
    <button class="sr-text-toggle" aria-pressed="false" aria-label="Comment on selected text" title="Comment on selected text">T</button>
    <span class="sr-separator"></span>
    <button class="sr-send" aria-label="Send review comments" title="Send review comments">
      <span aria-hidden="true">&#10003;</span>
      <span class="sr-send-label">Send</span>
    </button>
    <span class="sr-separator"></span>
    <button class="sr-icon sr-info" aria-label="About HTML Review" aria-expanded="false" title="About HTML Review">i</button>
    <button class="sr-icon sr-cancel" aria-label="Cancel review" title="Cancel review">&#215;</button>
    <div class="sr-status" role="status"></div>
  `;
  document.documentElement.appendChild(root);

  const status = root.querySelector('.sr-status');
  const addButton = root.querySelector('.sr-add');
  const textButton = root.querySelector('.sr-text-toggle');
  const infoButton = root.querySelector('.sr-info');
  const count = root.querySelector('.sr-count');
  const initialComments = __INITIAL_COMMENTS__;
  const comments = initialComments.map(item => ({...item}));
  const pendingComments = new Map();
  const pendingDeletedIds = new Set();
  const pins = new Map();
  const highlights = new Map();
  let mode = 'interact';
  let hovered = null;
  let popup = null;
  let infoPanel = null;
  let draft = null;
  let draftSaveTimer = null;
  let draftSavePromise = Promise.resolve();
  let finished = false;

  const clamp = (value, minimum, maximum) => Math.min(Math.max(minimum, value), maximum);
  const isOverlay = (node) => node instanceof Element && Boolean(node.closest('.steward-review-ui'));
  // Review controls must be inert from the host page's perspective. Let each
  // control receive the event, then stop it at the nearest review UI boundary
  // before document-level outside-click handlers, shortcuts, or analytics do.
  const shieldReviewUi = (node) => {
    for (const eventName of [
      'pointerdown', 'pointerup', 'mousedown', 'mouseup',
      'touchstart', 'touchend', 'click', 'dblclick', 'contextmenu',
      'focusin', 'focusout', 'keydown', 'keyup', 'input', 'change', 'submit'
    ]) {
      node.addEventListener(eventName, (event) => event.stopPropagation());
    }
  };
  shieldReviewUi(root);
  const visible = (node) => {
    if (!(node instanceof Element) || isOverlay(node)) return false;
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };
  // `showModal()` sets neither role nor aria-modal, so native dialogs need
  // their own selector to be found alongside library-rendered modals.
  const MODAL_HOST_SELECTOR = '[role="dialog"], [aria-modal="true"], dialog[open]';
  const activeModalHost = () => {
    const focusedDialog = document.activeElement instanceof Element
      ? document.activeElement.closest(MODAL_HOST_SELECTOR)
      : null;
    if (focusedDialog && visible(focusedDialog)) return focusedDialog;
    return [...document.querySelectorAll(MODAL_HOST_SELECTOR)].filter(visible).at(-1) || null;
  };
  const esc = (value) => window.CSS && CSS.escape ? CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  const cssPath = (node) => {
    const parts = [];
    for (let current = node; current && current.nodeType === 1 && current !== document.documentElement; current = current.parentElement) {
      if (current.id && current.id !== 'steward-review-root') { parts.unshift(`#${esc(current.id)}`); break; }
      let part = current.tagName.toLowerCase();
      const siblings = current.parentElement ? [...current.parentElement.children].filter(item => item.tagName === current.tagName) : [];
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      parts.unshift(part);
    }
    return parts.join(' > ');
  };
  const xpath = (node) => {
    const parts = [];
    for (let current = node; current && current.nodeType === 1; current = current.parentElement) {
      const siblings = current.parentElement ? [...current.parentElement.children].filter(item => item.tagName === current.tagName) : [];
      const suffix = siblings.length > 1 ? `[${siblings.indexOf(current) + 1}]` : '';
      parts.unshift(`${current.tagName.toLowerCase()}${suffix}`);
    }
    return '/' + parts.join('/');
  };
  const elementReference = (node) => {
    const rect = node.getBoundingClientRect();
    return {
      css_selector: cssPath(node),
      xpath: xpath(node),
      tag: node.tagName.toLowerCase(),
      id: node.id || null,
      classes: [...node.classList].filter(name => !name.startsWith('steward-review-')),
      text_excerpt: (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 240),
      attributes: Object.fromEntries([...node.attributes].filter(attr => !['class', 'id', 'style'].includes(attr.name)).slice(0, 20).map(attr => [attr.name, attr.value.slice(0, 240)])),
      bounding_rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
    };
  };
  const clearHover = () => {
    if (hovered) hovered.classList.remove('steward-review-hover');
    hovered = null;
  };
  const setMode = (nextMode) => {
    mode = nextMode;
    addButton.setAttribute('aria-pressed', String(mode === 'element'));
    textButton.setAttribute('aria-pressed', String(mode === 'text'));
    if (mode === 'element') status.textContent = 'Select an element - Esc to exit';
    else if (mode === 'text') status.textContent = 'Select text to comment - Esc to exit';
    else status.textContent = '';
    if (mode !== 'element') clearHover();
    if (mode !== 'text') window.getSelection()?.removeAllRanges();
  };

  const closeInfo = () => {
    if (infoPanel) infoPanel.remove();
    infoPanel = null;
    infoButton.setAttribute('aria-expanded', 'false');
  };
  const openInfo = () => {
    closeInfo();
    infoPanel = document.createElement('aside');
    infoPanel.className = 'steward-review-ui steward-review-info';
    infoPanel.setAttribute('aria-label', 'About HTML Review');
    infoPanel.innerHTML = `
      <a class="sr-creator" href="${TOOL_INFO.creatorUrl}" target="_blank" rel="noopener noreferrer">
        ${TOOL_INFO.creatorLabel}
      </a>
      <span class="sr-info-divider" aria-hidden="true"></span>
      <a class="sr-source" href="${TOOL_INFO.repositoryUrl}" target="_blank" rel="noopener noreferrer" aria-label="View source on GitHub" title="View source on GitHub">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path fill="currentColor" d="M12 .7a12 12 0 0 0-3.79 23.39c.6.11.82-.26.82-.58v-2.1c-3.34.73-4.04-1.42-4.04-1.42-.55-1.39-1.33-1.76-1.33-1.76-1.09-.74.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.84 2.81 1.31 3.5 1 .11-.78.42-1.31.76-1.61-2.67-.3-5.47-1.34-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.11-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.65 1.66.24 2.88.12 3.18.77.84 1.23 1.91 1.23 3.22 0 4.6-2.81 5.62-5.48 5.92.43.37.81 1.1.81 2.22v3.29c0 .32.22.7.82.58A12 12 0 0 0 12 .7Z"></path>
        </svg>
      </a>
    `;
    shieldReviewUi(infoPanel);
    // Keep fixed positioning outside the transformed toolbar; that transform
    // would otherwise create a different containing block before first drag.
    document.documentElement.appendChild(infoPanel);

    const buttonRect = infoButton.getBoundingClientRect();
    const maximumLeft = window.innerWidth - infoPanel.offsetWidth - 12;
    const left = clamp(buttonRect.right - infoPanel.offsetWidth, 12, maximumLeft);
    const below = buttonRect.bottom + 10;
    const above = buttonRect.top - infoPanel.offsetHeight - 10;
    const top = below + infoPanel.offsetHeight <= window.innerHeight - 12 ? below : Math.max(12, above);
    infoPanel.style.left = `${Math.round(left)}px`;
    infoPanel.style.top = `${Math.round(top)}px`;
    infoButton.setAttribute('aria-expanded', 'true');
    infoPanel.querySelector('a').focus({preventScroll: true});
  };
  const toggleInfo = () => infoPanel ? closeInfo() : openInfo();

  // Element and text references are intentionally redundant. Selectors locate
  // the target; text, offsets, and surrounding context disambiguate repeats.
  const endpointReference = (container, offset) => {
    const parent = container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement;
    if (!parent || isOverlay(parent)) return null;
    const path = [];
    let current = container;
    while (current !== parent) {
      const parentNode = current.parentNode;
      if (!parentNode) return null;
      path.unshift([...parentNode.childNodes].indexOf(current));
      current = parentNode;
    }
    return { parent_css_selector: cssPath(parent), node_path: path, offset };
  };
  const surroundingText = (range, commonElement) => {
    const beforeRange = document.createRange();
    beforeRange.selectNodeContents(commonElement);
    beforeRange.setEnd(range.startContainer, range.startOffset);
    const afterRange = document.createRange();
    afterRange.selectNodeContents(commonElement);
    afterRange.setStart(range.endContainer, range.endOffset);
    return {
      before: beforeRange.toString().slice(-160),
      after: afterRange.toString().slice(0, 160)
    };
  };
  const rangeReference = (range) => {
    const commonElement = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
    const start = endpointReference(range.startContainer, range.startOffset);
    const end = endpointReference(range.endContainer, range.endOffset);
    if (!commonElement || isOverlay(commonElement) || !start || !end) return null;
    const context = surroundingText(range, commonElement);
    return {
      selected_text: range.toString(),
      common_ancestor: elementReference(commonElement),
      start,
      end,
      context_before: context.before,
      context_after: context.after
    };
  };
  const resolveEndpoint = (reference) => {
    const parent = document.querySelector(reference.parent_css_selector);
    if (!parent || isOverlay(parent)) return null;
    let node = parent;
    for (const index of reference.node_path || []) {
      node = node.childNodes[index];
      if (!node) return null;
    }
    const maximum = node.nodeType === Node.TEXT_NODE ? node.data.length : node.childNodes.length;
    if (!Number.isInteger(reference.offset) || reference.offset < 0 || reference.offset > maximum) return null;
    return { node, offset: reference.offset };
  };
  const resolveRange = (selection) => {
    if (!selection?.start || !selection?.end) return null;
    const start = resolveEndpoint(selection.start);
    const end = resolveEndpoint(selection.end);
    if (!start || !end) return null;
    try {
      const range = document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      return range.toString() === selection.selected_text ? range : null;
    } catch {
      return null;
    }
  };
  const resolveElement = (reference) => {
    if (!reference?.css_selector) return null;
    try {
      const node = document.querySelector(reference.css_selector);
      return visible(node) ? node : null;
    } catch {
      return null;
    }
  };
  const rangeRects = (range) => [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
  const removeHighlight = (id) => {
    for (const node of highlights.get(id) || []) node.remove();
    highlights.delete(id);
  };
  const drawHighlight = (id, range) => {
    removeHighlight(id);
    const nodes = rangeRects(range).map(rect => {
      const highlight = document.createElement('div');
      highlight.className = 'steward-review-ui steward-review-highlight';
      highlight.style.left = `${Math.round(rect.left + window.scrollX)}px`;
      highlight.style.top = `${Math.round(rect.top + window.scrollY)}px`;
      highlight.style.width = `${Math.round(rect.width)}px`;
      highlight.style.height = `${Math.round(rect.height)}px`;
      document.documentElement.appendChild(highlight);
      return highlight;
    });
    highlights.set(id, nodes);
    return nodes;
  };
  const anchorForRange = (range) => {
    const rects = rangeRects(range);
    const rect = rects.at(-1);
    return rect ? { x: Math.round(rect.right + window.scrollX), y: Math.round(rect.top + window.scrollY) } : null;
  };

  // Draft persistence includes unsaved textarea content so an interrupted tab
  // can be recovered without treating it as a submitted review.
  const recoverableComments = () => {
    const recovered = comments.filter(item => item.comment.trim()).map(item => ({...item}));
    const textarea = popup ? popup.querySelector('textarea') : null;
    const text = textarea ? textarea.value.trim() : '';
    if (!text || !draft) return recovered;
    if (draft.item) {
      const index = recovered.findIndex(item => item.id === draft.item.id);
      const item = {...draft.item, comment: text, updated_at: new Date().toISOString()};
      if (index >= 0) recovered[index] = item;
      else recovered.push(item);
    } else {
      recovered.push({ id: draft.id, target_type: draft.targetType, element: draft.element, selection: draft.selection, anchor: draft.anchor, anchor_ratio: draft.anchorRatio, comment: text, created_at: draft.created_at });
    }
    return recovered;
  };
  const rememberComment = item => {
    pendingDeletedIds.delete(item.id);
    pendingComments.set(item.id, {...item});
  };
  const rememberDeletion = id => {
    pendingComments.delete(id);
    pendingDeletedIds.add(id);
  };
  const rememberOpenDraft = () => {
    if (!popup || !draft) return;
    const recoverable = recoverableComments().find(item => item.id === (draft.item?.id || draft.id));
    if (recoverable) rememberComment(recoverable);
    else if (draft.item) rememberComment(draft.item);
    else rememberDeletion(draft.id);
  };
  const saveDraft = () => {
    if (finished) return draftSavePromise;
    if (draftSaveTimer) clearTimeout(draftSaveTimer);
    draftSaveTimer = null;
    if (!pendingComments.size && !pendingDeletedIds.size) return draftSavePromise;
    const savedComments = new Map(pendingComments);
    const savedDeletedIds = new Set(pendingDeletedIds);
    draftSavePromise = draftSavePromise.catch(() => {}).then(async () => {
      const response = await fetch(`${endpoint}/draft`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ comments: [...savedComments.values()], deleted_ids: [...savedDeletedIds] }),
        keepalive: true
      });
      if (!response.ok) throw new Error(await response.text());
      for (const [id, item] of savedComments) {
        if (pendingComments.get(id) === item) pendingComments.delete(id);
      }
      for (const id of savedDeletedIds) {
        if (pendingDeletedIds.has(id)) pendingDeletedIds.delete(id);
      }
    });
    return draftSavePromise;
  };
  const queueDraftSave = () => {
    if (finished) return;
    if (draftSaveTimer) clearTimeout(draftSaveTimer);
    draftSaveTimer = setTimeout(() => saveDraft().catch(error => {
      status.textContent = `Could not save review draft: ${error.message}`;
    }), 200);
  };

  // Comment pins own saved feedback; the editor owns only the comment being
  // created or changed. Closing an editor discards its temporary screen
  // position but keeps any previously saved comment anchored to the page.
  const closePopup = () => {
    if (draft?.item) rememberComment(draft.item);
    else if (draft) rememberDeletion(draft.id);
    if (draft?.provisionalId) removeHighlight(draft.provisionalId);
    if (popup) popup.remove();
    popup = null;
    draft = null;
    queueDraftSave();
  };
  const updateCount = () => {
    count.textContent = String(comments.length);
    count.dataset.count = String(comments.length);
    count.setAttribute('aria-label', `${comments.length} comment${comments.length === 1 ? '' : 's'}`);
  };
  const anchorForComment = (item) => {
    if (item.target_type === 'text' && item.selection) {
      const range = resolveRange(item.selection);
      if (!range) return item.anchor;
      drawHighlight(item.id, range);
      return anchorForRange(range) || item.anchor;
    }
    if (item.target_type === 'element' && item.anchor_ratio) {
      const target = resolveElement(item.element);
      if (!target) return item.anchor;
      const rect = target.getBoundingClientRect();
      return {
        x: Math.round(rect.left + window.scrollX + rect.width * item.anchor_ratio.x),
        y: Math.round(rect.top + window.scrollY + rect.height * item.anchor_ratio.y)
      };
    }
    return item.anchor;
  };
  const pinFor = (item) => {
    const anchor = anchorForComment(item);
    if (!anchor) return;
    const pin = document.createElement('button');
    pin.className = 'steward-review-ui steward-review-pin';
    pin.type = 'button';
    pin.textContent = String(comments.indexOf(item) + 1);
    pin.style.left = `${anchor.x}px`;
    pin.style.top = `${anchor.y}px`;
    pin.setAttribute('aria-label', `Open comment ${comments.indexOf(item) + 1}`);
    shieldReviewUi(pin);
    pin.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); openPopup(item, event.clientX, event.clientY); });
    document.documentElement.appendChild(pin);
    pins.set(item.id, pin);
    updateCount();
  };
  const renumberPins = () => comments.forEach((item, index) => {
    const pin = pins.get(item.id);
    if (pin) { pin.textContent = String(index + 1); pin.setAttribute('aria-label', `Open comment ${index + 1}`); }
  });
  const deleteComment = (item) => {
    const index = comments.indexOf(item);
    if (index >= 0) comments.splice(index, 1);
    const pin = pins.get(item.id);
    if (pin) pin.remove();
    pins.delete(item.id);
    removeHighlight(item.id);
    closePopup();
    rememberDeletion(item.id);
    renumberPins();
    updateCount();
    queueDraftSave();
  };
  const savePopup = () => {
    if (!popup || !draft) return;
    const text = popup.querySelector('textarea').value.trim();
    if (!text) return;
    let savedItem;
    if (draft.item) {
      draft.item.comment = text;
      draft.item.updated_at = new Date().toISOString();
      rememberComment(draft.item);
      savedItem = draft.item;
    } else {
      const item = { id: draft.id, target_type: draft.targetType, element: draft.element, selection: draft.selection, anchor: draft.anchor, anchor_ratio: draft.anchorRatio, comment: text, created_at: draft.created_at };
      comments.push(item);
      rememberComment(item);
      pinFor(item);
      savedItem = item;
    }
    draft = { item: savedItem, provisionalId: draft.provisionalId };
    closePopup();
  };
  const openPopup = (item, clientX, clientY, target = null) => {
    closeInfo();
    closePopup();
    popup = document.createElement('div');
    popup.className = 'steward-review-ui steward-review-popup';
    const number = item ? comments.indexOf(item) + 1 : null;
    popup.innerHTML = `
      <div class="sr-popup-head">
        <div>
          <div class="sr-kicker">${item ? `Comment ${number}` : 'New comment'}</div>
          <div class="sr-popup-title">${item ? 'Review feedback' : 'Add feedback'}</div>
        </div>
        <button class="sr-close" aria-label="Close comment" title="Close comment">&#215;</button>
      </div>
      <textarea aria-label="Comment" placeholder="What should change?"></textarea>
      <div class="sr-popup-footer">
        <span class="sr-hint">Enter to save - Shift+Enter for a new line</span>
        <div class="sr-popup-actions">
          ${item ? '<button class="sr-delete">Delete</button>' : ''}
          <button class="sr-save" disabled>Save</button>
        </div>
      </div>
      <div class="sr-error" role="status"></div>
    `;
    shieldReviewUi(popup);
    // Focus-trapping dialog libraries reject focus outside their content.
    // Keep the editor inside the active dialog so its textarea remains usable
    // without weakening the page's production modal behavior.
    const popupHost = activeModalHost() || document.documentElement;
    popupHost.appendChild(popup);
    draft = item ? { item } : {
      ...target,
      id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
      created_at: new Date().toISOString()
    };
    const placePopup = (left, top) => {
      const hostRect = popupHost === document.documentElement
        ? { left: 0, top: 0 }
        : popupHost.getBoundingClientRect();
      const scrollLeft = popupHost === document.documentElement ? 0 : popupHost.scrollLeft;
      const scrollTop = popupHost === document.documentElement ? 0 : popupHost.scrollTop;
      const hostWidth = popupHost === document.documentElement ? window.innerWidth : popupHost.clientWidth;
      const hostHeight = popupHost === document.documentElement ? window.innerHeight : popupHost.clientHeight;
      const minimumX = scrollLeft + 12;
      const minimumY = scrollTop + 12;
      const maximumX = Math.max(minimumX, scrollLeft + hostWidth - popup.offsetWidth - 12);
      const maximumY = Math.max(minimumY, scrollTop + hostHeight - popup.offsetHeight - 12);
      const position = {
        x: Math.round(clamp(left - hostRect.left + scrollLeft, minimumX, maximumX)),
        y: Math.round(clamp(top - hostRect.top + scrollTop, minimumY, maximumY))
      };
      popup.style.left = `${position.x}px`;
      popup.style.top = `${position.y}px`;
    };
    placePopup(clientX + 14, clientY + 14);
    if (!item && target?.range) {
      draft.provisionalId = `draft-${draft.id}`;
      drawHighlight(draft.provisionalId, target.range);
      delete draft.range;
    }
    const textarea = popup.querySelector('textarea');
    const save = popup.querySelector('.sr-save');
    textarea.value = item ? item.comment : '';
    save.disabled = !textarea.value.trim();
    textarea.addEventListener('input', () => {
      save.disabled = !textarea.value.trim();
      rememberOpenDraft();
      queueDraftSave();
    });
    textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); savePopup(); }
      if (event.key === 'Escape') { event.preventDefault(); closePopup(); }
    });
    popup.querySelector('.sr-close').addEventListener('click', closePopup);
    save.addEventListener('click', savePopup);
    if (item) popup.querySelector('.sr-delete').addEventListener('click', () => deleteComment(item));
    const dragHandle = popup.querySelector('.sr-popup-head');
    dragHandle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('button')) return;
      event.preventDefault();
      dragHandle.setPointerCapture(event.pointerId);
      const rect = popup.getBoundingClientRect();
      const offsetX = event.clientX - rect.left;
      const offsetY = event.clientY - rect.top;
      const move = (moveEvent) => placePopup(moveEvent.clientX - offsetX, moveEvent.clientY - offsetY);
      const end = () => {
        dragHandle.removeEventListener('pointermove', move);
        dragHandle.removeEventListener('pointerup', end);
        dragHandle.removeEventListener('pointercancel', end);
      };
      dragHandle.addEventListener('pointermove', move);
      dragHandle.addEventListener('pointerup', end);
      dragHandle.addEventListener('pointercancel', end);
    });
    textarea.focus();
  };

  comments.forEach(pinFor);
  updateCount();
  // Toolbar and page event wiring stays together so capture-phase behavior is
  // easy to audit against the host page's own controls.
  addButton.addEventListener('click', () => { closeInfo(); closePopup(); setMode(mode === 'element' ? 'interact' : 'element'); });
  textButton.addEventListener('click', () => { closeInfo(); closePopup(); setMode(mode === 'text' ? 'interact' : 'text'); });
  infoButton.addEventListener('click', toggleInfo);
  document.addEventListener('pointerdown', (event) => {
    if (infoPanel && !infoPanel.contains(event.target) && !infoButton.contains(event.target)) closeInfo();
  });
  document.addEventListener('pointerover', (event) => {
    if (mode !== 'element' || !visible(event.target)) return;
    clearHover();
    hovered = event.target;
    hovered.classList.add('steward-review-hover');
  }, true);
  document.addEventListener('pointerout', (event) => {
    if (event.target === hovered) clearHover();
  }, true);
  document.addEventListener('click', (event) => {
    if (isOverlay(event.target)) return;
    if (mode === 'text') {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (mode !== 'element' || !visible(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const target = event.target;
    const element = elementReference(target);
    const anchor = { x: Math.round(event.pageX), y: Math.round(event.pageY) };
    const rect = target.getBoundingClientRect();
    const anchorRatio = {
      x: clamp((event.clientX - rect.left) / rect.width, 0, 1),
      y: clamp((event.clientY - rect.top) / rect.height, 0, 1)
    };
    clearHover();
    setMode('interact');
    openPopup(null, event.clientX, event.clientY, { targetType: 'element', element, anchor, anchorRatio });
  }, true);
  document.addEventListener('pointerup', (event) => {
    if (mode !== 'text' || isOverlay(event.target)) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) {
      status.textContent = 'Drag across text to select it - Esc to exit';
      return;
    }
    const range = selection.getRangeAt(0).cloneRange();
    const reference = rangeReference(range);
    const anchor = anchorForRange(range);
    if (!reference || !reference.selected_text.trim() || !anchor) {
      status.textContent = 'That selection cannot be annotated. Select page text outside the review controls.';
      return;
    }
    setMode('interact');
    openPopup(null, event.clientX, event.clientY, {
      targetType: 'text',
      element: reference.common_ancestor,
      selection: reference,
      anchor,
      range
    });
  }, true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && infoPanel) {
      event.preventDefault();
      closeInfo();
      infoButton.focus();
      return;
    }
    if (event.key === 'Escape' && mode !== 'interact') { event.preventDefault(); setMode('interact'); }
  }, true);

  const refreshComments = () => {
    for (const item of comments) {
      const anchor = anchorForComment(item);
      const pin = pins.get(item.id);
      if (anchor && pin) {
        pin.style.left = `${anchor.x}px`;
        pin.style.top = `${anchor.y}px`;
      }
    }
  };
  window.addEventListener('resize', () => {
    closeInfo();
    requestAnimationFrame(refreshComments);
  });
  if (document.fonts?.ready) document.fonts.ready.then(refreshComments);

  const dragHandle = root.querySelector('.sr-drag');
  dragHandle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    closeInfo();
    dragHandle.setPointerCapture(event.pointerId);
    const rect = root.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;
    // The initial CSS position is centered with a transform. Convert it to
    // equivalent pixel coordinates before removing that transform, otherwise
    // the toolbar jumps on the first drag.
    root.style.left = `${rect.left}px`;
    root.style.top = `${rect.top}px`;
    root.style.transform = 'none';
    const move = (moveEvent) => {
      root.style.left = `${clamp(moveEvent.clientX - offsetX, 8, window.innerWidth - root.offsetWidth - 8)}px`;
      root.style.top = `${clamp(moveEvent.clientY - offsetY, 8, window.innerHeight - root.offsetHeight - 8)}px`;
    };
    const end = () => { dragHandle.removeEventListener('pointermove', move); dragHandle.removeEventListener('pointerup', end); dragHandle.removeEventListener('pointercancel', end); };
    dragHandle.addEventListener('pointermove', move);
    dragHandle.addEventListener('pointerup', end);
    dragHandle.addEventListener('pointercancel', end);
  });

  const finish = async (action) => {
    if (action === 'submit' && popup) {
      popup.querySelector('.sr-error').textContent = 'Save or close this comment before sending.';
      popup.querySelector('textarea').focus();
      return;
    }
    setMode('interact');
    closeInfo();
    closePopup();
    status.textContent = '';
    try {
      await saveDraft();
      const response = await fetch(`${endpoint}/${action}`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}' });
      if (!response.ok) throw new Error(await response.text());
      finished = true;
      document.documentElement.innerHTML = `<head><title>Review ${action === 'submit' ? 'submitted' : 'cancelled'}</title></head><body style="font:16px/1.5 system-ui;padding:3rem"><h1>Review ${action === 'submit' ? 'submitted' : 'cancelled'}</h1><p>You can close this tab.</p></body>`;
    } catch (error) { status.textContent = `Could not finish review: ${error.message}`; }
  };
  window.addEventListener('pagehide', () => {
    if (finished) return;
    if (draftSaveTimer) clearTimeout(draftSaveTimer);
    rememberOpenDraft();
    if (!pendingComments.size && !pendingDeletedIds.size) return;
    const body = JSON.stringify({ comments: [...pendingComments.values()], deleted_ids: [...pendingDeletedIds] });
    const queued = navigator.sendBeacon && navigator.sendBeacon(`${endpoint}/draft`, new Blob([body], {type: 'application/json'}));
    if (!queued) fetch(`${endpoint}/draft`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body, keepalive: true });
  });
  root.querySelector('.sr-send').addEventListener('click', () => finish('submit'));
  root.querySelector('.sr-cancel').addEventListener('click', () => finish('cancel'));
})();

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
.steward-review-ui, .steward-review-ui * { box-sizing: border-box; pointer-events: auto; }
#steward-review-root { position: fixed; z-index: 2147483647; top: 22px; left: 50%; display: flex; align-items: center; gap: 5px; min-height: 50px; padding: 6px; color: #f8fafc; background: rgba(15,23,42,.96); border: 1px solid rgba(255,255,255,.18); border-radius: 999px; box-shadow: 0 16px 44px rgba(15,23,42,.28), 0 2px 8px rgba(15,23,42,.18); transform: translateX(-50%); font: 14px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; backdrop-filter: blur(14px); user-select: none; }
#steward-review-root.steward-review-enter { animation: steward-review-enter .18s ease-out; }
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
.steward-review-pin { position: absolute; z-index: 2147483645; display: grid; width: 31px; height: 31px; cursor: pointer; place-items: center; padding: 0; color: #172554; background: #facc15; border: 2px solid #172554; border-radius: 9px; box-shadow: 0 6px 18px rgba(23,37,84,.28); transform: translate(-50%,-50%); transition: background .14s ease, box-shadow .14s ease, transform .14s ease; font: 800 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
.steward-review-pin[hidden] { display: none !important; }
.steward-review-pin.sr-enter { animation: steward-review-pin-in .22s cubic-bezier(.2,.8,.2,1.2); }
.steward-review-pin:hover, .steward-review-pin:focus-visible { background: #fde047; box-shadow: 0 8px 22px rgba(23,37,84,.34); transform: translate(-50%,-50%) scale(1.08); outline: none; }
.steward-review-highlight { position: absolute; z-index: 2147483644; border-radius: 3px; background: rgba(250,204,21,.42); box-shadow: 0 0 0 1px rgba(202,138,4,.16); pointer-events: none; }
.steward-review-popup { position: fixed; z-index: 2147483646; width: min(350px, calc(100vw - 24px)); padding: 14px; color: #172033; background: #fff; border: 1px solid #cbd5e1; border-radius: 16px; box-shadow: 0 22px 60px rgba(15,23,42,.3), 0 2px 8px rgba(15,23,42,.1); font: 14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
.steward-review-popup.sr-enter, .steward-review-info.sr-enter { animation: steward-review-popup-in .16s ease-out; }
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
.steward-review-info { position: fixed; z-index: 2147483646; display: flex; align-items: center; gap: 4px; width: max-content; max-width: calc(100vw - 24px); padding: 7px; color: #172033; background: #fff; border: 1px solid #cbd5e1; border-radius: 13px; box-shadow: 0 18px 48px rgba(15,23,42,.24), 0 2px 7px rgba(15,23,42,.1); font: 13px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
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
:host, :host(:popover-open) { position: fixed !important; inset: unset !important; top: 0 !important; left: 0 !important; display: block; width: 0 !important; height: 0 !important; min-width: 0 !important; min-height: 0 !important; max-width: none !important; max-height: none !important; margin: 0 !important; padding: 0 !important; border: none !important; overflow: visible !important; background: transparent !important; color: inherit !important; pointer-events: none; z-index: 2147483647; }
:host::backdrop, .steward-review-popup::backdrop, .steward-review-info::backdrop { display: none; }
.steward-review-popup, .steward-review-popup:popover-open { position: fixed !important; margin: 0 !important; width: min(350px, calc(100vw - 24px)) !important; height: fit-content !important; overflow: visible !important; }
.steward-review-info, .steward-review-info:popover-open { position: fixed !important; margin: 0 !important; width: max-content !important; height: fit-content !important; overflow: visible !important; }
@media (prefers-reduced-motion: reduce) { #steward-review-root, .steward-review-pin, .steward-review-popup, .steward-review-info, .steward-review-pin.sr-enter, .steward-review-popup.sr-enter, .steward-review-info.sr-enter, #steward-review-root .sr-status { animation: none; transition: none; } }
`;

  // Bootstrap one isolated overlay. The server replaces the two sentinel
  // values below before this script reaches the browser.
  const endpoint = __ENDPOINT__;
  // This is the only review rule that intentionally targets page content.
  // Keep it in the document; all review chrome styles live in the shadow root.
  // Document styles cannot cross a shadow boundary, so the rule is copied into
  // an open shadow root on demand when one of its elements is hovered.
  const pageStyle = document.createElement('style');
  pageStyle.id = 'steward-review-page-style';
  pageStyle.textContent = '.steward-review-hover { outline: 3px solid #3b82f6 !important; outline-offset: 2px !important; cursor: crosshair !important; }';
  document.head.appendChild(pageStyle);
  const overlayLayer = document.createElement('div');
  overlayLayer.className = 'steward-review-ui sr-layer';
  overlayLayer.setAttribute('popover', 'manual');
  // The host must remain a descendant of an active modal so native inertness
  // and library focus traps permit interaction. Keep every visible control in
  // a shadow tree so broad page rules such as `dialog *` cannot restyle it.
  // Inline-important host geometry also protects the one node page CSS can
  // still reach from clipping, sizing, and pointer-event overrides.
  overlayLayer.style.cssText = 'position:fixed!important;inset:auto!important;top:0!important;left:0!important;display:block!important;width:0!important;height:0!important;min-width:0!important;min-height:0!important;max-width:none!important;max-height:none!important;margin:0!important;padding:0!important;border:0!important;overflow:visible!important;background:transparent!important;pointer-events:none!important;z-index:2147483647!important';
  // Keep the root open so browser automation and accessibility tooling can
  // inspect the review controls; shadow CSS isolation does not depend on mode.
  const overlayShadow = overlayLayer.attachShadow({mode: 'open'});
  const overlayStyle = document.createElement('style');
  overlayStyle.textContent = overlayCss;
  overlayShadow.appendChild(overlayStyle);
  const root = document.createElement('div');
  root.id = 'steward-review-root';
  root.className = 'steward-review-ui steward-review-enter';
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
  overlayShadow.appendChild(root);
  document.documentElement.appendChild(overlayLayer);
  root.addEventListener('animationend', () => root.classList.remove('steward-review-enter'), {once: true});
  setTimeout(() => root.classList.remove('steward-review-enter'), 250);

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
  const hoverStyleRoots = new WeakSet();
  let popup = null;
  let infoPanel = null;
  let draft = null;
  let draftSaveTimer = null;
  let draftSavePromise = Promise.resolve();
  let finished = false;
  // Modal-host synchronization runs during startup, before saved comment
  // positioning is fully wired. Use a safe callback until the real refresher
  // is assigned below; referencing a later `const` here would throw in its
  // temporal dead zone and abort every annotation event handler.
  let refreshComments = () => {};
  let refreshCommentsFrame = null;
  let scheduleCommentRefresh = () => {};
  const registeredDocuments = new Set();
  const watchedFrames = new WeakSet();
  const frameDocuments = new WeakMap();
  const renderedAnchors = new Map();
  const shadowFrameObservers = new WeakMap();

  const clamp = (value, minimum, maximum) => Math.min(Math.max(minimum, value), maximum);
  // Same-origin iframe documents are a different JS realm. Top-window
  // constructor checks fail there, so helpers use nodeType instead.
  const isElement = (node) => Boolean(node) && node.nodeType === 1;
  const isShadowRoot = (node) => Boolean(node) && node.nodeType === 11 && Boolean(node.host);
  const ownerDocumentOf = (node) => {
    if (!node) return document;
    if (node.nodeType === 9) return node;
    return node.ownerDocument || document;
  };
  const ownerWindowOf = (node) => ownerDocumentOf(node).defaultView || window;
  const viewportRect = (view) => ({ left: 0, top: 0, right: view.innerWidth, bottom: view.innerHeight, width: view.innerWidth, height: view.innerHeight });
  const isFrameElement = (node) => isElement(node) && /^(IFRAME|FRAME)$/.test(node.tagName);
  const { clampPinToClip, intersectClippedAxes, isAxisAlignedTransform, mapPointToTop, mapRectToTop } = __stewardReviewGeometry;
  const overflowClips = (value) => ['hidden', 'clip', 'auto', 'scroll'].includes(value);
  const composedAncestors = (node) => {
    const ancestors = [];
    for (let current = node; current;) {
      if (isElement(current)) ancestors.push(current);
      if (current.parentElement) {
        current = current.parentElement;
        continue;
      }
      const root = current.getRootNode?.();
      current = isShadowRoot(root) ? root.host : null;
    }
    return ancestors;
  };
  // A frame's content box can itself be cut down by any scrolling or
  // overflow-clipping ancestor in the parent document. Only same-origin
  // ancestors are considered; inaccessible frame geometry is never guessed.
  const visibleFrameContentRect = (frame, contentRect) => {
    let visibleRect = contentRect;
    const view = ownerWindowOf(frame);
    const frameDocument = ownerDocumentOf(frame);
    const root = frameDocument.documentElement;
    for (const ancestor of composedAncestors(frame).slice(1)) {
      if (!visibleRect) break;
      // The root is clipped by the viewport through parentSource below, not
      // by its document-sized border box. Treating it as an ancestor clip
      // incorrectly hides frames after a deeply scrolled document moves the
      // root rect away from the viewport.
      if (ancestor === root) continue;
      const style = view.getComputedStyle(ancestor);
      let clipX = overflowClips(style.overflowX);
      let clipY = overflowClips(style.overflowY);
      // When root overflow is visible, body overflow propagates to the
      // viewport. parentSource already provides that viewport clip, so body
      // must not apply a second document-sized clip on that axis.
      if (ancestor === frameDocument.body && root) {
        const rootStyle = view.getComputedStyle(root);
        if (rootStyle.overflowX === 'visible') clipX = false;
        if (rootStyle.overflowY === 'visible') clipY = false;
      }
      if (!clipX && !clipY) continue;
      const rect = ancestor.getBoundingClientRect();
      const scaleX = ancestor.offsetWidth ? rect.width / ancestor.offsetWidth : 1;
      const scaleY = ancestor.offsetHeight ? rect.height / ancestor.offsetHeight : 1;
      const paddingBox = {
        left: rect.left + ancestor.clientLeft * scaleX,
        top: rect.top + ancestor.clientTop * scaleY,
        right: rect.left + (ancestor.clientLeft + ancestor.clientWidth) * scaleX,
        bottom: rect.top + (ancestor.clientTop + ancestor.clientHeight) * scaleY
      };
      visibleRect = intersectClippedAxes(visibleRect, paddingBox, clipX, clipY);
    }
    return visibleRect;
  };
  const directFrameFor = (node) => {
    const view = ownerWindowOf(node);
    if (view === window) return null;
    try {
      const frame = view.frameElement;
      return isFrameElement(frame) ? frame : null;
    } catch {
      return null;
    }
  };
  // Innermost frame first. Null means an inaccessible (usually cross-origin)
  // hop, so callers must not persist a partial path or guess geometry.
  const ancestorFramesFor = (node) => {
    const frames = [];
    let current = node;
    while (true) {
      const frame = directFrameFor(current);
      if (!frame) return ownerWindowOf(current) === window ? frames : null;
      frames.push(frame);
      current = frame;
    }
  };
  const FRAME_TRANSFORM_STATUS = 'Comments inside this iframe cannot be annotated because its frame layout uses a rotated, skewed, or 3D transform.';
  const transformedFrameAncestor = (frame) => composedAncestors(frame).find((ancestor) => {
    const style = ownerWindowOf(frame).getComputedStyle(ancestor);
    return !isAxisAlignedTransform(style.transform)
      || (style.rotate && style.rotate !== 'none')
      || (style.perspective && style.perspective !== 'none');
  });
  const frameGeometryFor = (node) => {
    const view = ownerWindowOf(node);
    const source = viewportRect(view);
    const frames = ancestorFramesFor(node);
    if (!frames) return null;
    if (frames.some(transformedFrameAncestor)) return { frame: frames[0] || null, source, hops: [], unavailable: FRAME_TRANSFORM_STATUS };
    const hops = frames.map((frame) => {
      const rect = frame.getBoundingClientRect();
      const scaleX = frame.offsetWidth ? rect.width / frame.offsetWidth : 1;
      const scaleY = frame.offsetHeight ? rect.height / frame.offsetHeight : 1;
      const left = rect.left + frame.clientLeft * scaleX;
      const top = rect.top + frame.clientTop * scaleY;
      const parentView = ownerWindowOf(frame);
      const content = {
        left,
        top,
        right: left + frame.clientWidth * scaleX,
        bottom: top + frame.clientHeight * scaleY
      };
      return {
        frame,
        scaleX,
        scaleY,
        content,
        visibleClip: visibleFrameContentRect(frame, content),
        parentSource: viewportRect(parentView)
      };
    });
    const geometry = { frame: frames[0] || null, source, hops };
    if (hops.length) geometry.clip = mapRectToTop(source, geometry);
    return geometry;
  };
  const isOverlay = (node) => isElement(node) && Boolean(node.closest('.steward-review-ui'));
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
    if (!isElement(node) || isOverlay(node)) return false;
    const style = ownerWindowOf(node).getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };
  // `showModal()` sets neither role nor aria-modal, so native dialogs need
  // their own selector to be found alongside library-rendered modals.
  const MODAL_HOST_SELECTOR = '[role="dialog"], [aria-modal="true"], dialog[open]';
  const composedClosest = (node, selector) => {
    let current = isElement(node) ? node : null;
    while (current) {
      const match = current.closest(selector);
      if (match) return match;
      const currentRoot = current.getRootNode();
      current = isShadowRoot(currentRoot) ? currentRoot.host : null;
    }
    return null;
  };
  const deepestActiveElement = () => {
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    return active;
  };
  const visibleModalHosts = () => {
    const hosts = [];
    const visit = (scope) => {
      for (const node of scope.querySelectorAll(MODAL_HOST_SELECTOR)) {
        if (visible(node)) hosts.push(node);
      }
      for (const node of scope.querySelectorAll('*')) {
        if (node.shadowRoot) visit(node.shadowRoot);
      }
    };
    visit(document);
    return hosts;
  };
  const activeModalHost = () => {
    const focusedDialog = composedClosest(deepestActiveElement(), MODAL_HOST_SELECTOR);
    if (focusedDialog && visible(focusedDialog)) return focusedDialog;
    return visibleModalHosts().at(-1) || null;
  };
  const containingBlockOrigin = () => {
    const probe = document.createElement('div');
    probe.className = 'steward-review-ui';
    probe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;margin:0;padding:0;border:0;visibility:hidden;pointer-events:none';
    overlayShadow.appendChild(probe);
    const rect = probe.getBoundingClientRect();
    probe.remove();
    return { left: rect.left, top: rect.top };
  };
  const toContainingBlock = (clientX, clientY, origin = containingBlockOrigin()) => {
    return { x: clientX - origin.left, y: clientY - origin.top };
  };
  const placeToolbarDefault = (origin = containingBlockOrigin()) => {
    const width = root.offsetWidth;
    root.style.left = `${Math.round(window.innerWidth / 2 - width / 2 - origin.left)}px`;
    root.style.top = `${Math.round(22 - origin.top)}px`;
    root.style.transform = 'none';
  };
  const playEnter = (node) => {
    node.classList.add('sr-enter');
    node.addEventListener('animationend', () => node.classList.remove('sr-enter'), {once: true});
  };
  const copyRect = (node) => {
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0
      ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
      : null;
  };
  const restoreFixedPosition = (node, rect, origin = containingBlockOrigin()) => {
    if (!node || !rect) return;
    if (node === root) {
      root.classList.remove('steward-review-enter');
      root.style.setProperty('transform', 'none', 'important');
    }
    node.style.setProperty('right', 'auto');
    node.style.setProperty('bottom', 'auto');
    node.style.setProperty('left', `${Math.round(rect.left - origin.left)}px`);
    node.style.setProperty('top', `${Math.round(rect.top - origin.top)}px`);
  };
  const supportsPopover = (node) => typeof node.showPopover === 'function';
  const hideAsPopover = (node) => {
    if (!node || !supportsPopover(node) || !node.hasAttribute('popover')) return;
    try {
      if (node.matches(':popover-open')) node.hidePopover();
    } catch {}
  };
  const showAsPopover = (node) => {
    if (!node) return;
    if (!supportsPopover(node)) {
      node.removeAttribute('popover');
      return;
    }
    if (!node.hasAttribute('popover')) node.setAttribute('popover', 'manual');
    try {
      if (!node.matches(':popover-open')) node.showPopover();
    } catch {
      // A failed show would leave [popover] as `display: none`. Drop the
      // attribute so the overlay stays usable without top-layer promotion.
      node.removeAttribute('popover');
    }
  };
  const showOverlayLayer = () => showAsPopover(overlayLayer);
  const viewportClipRect = (padding = 12) => ({
    left: padding,
    top: padding,
    right: window.innerWidth - padding,
    bottom: window.innerHeight - padding
  });
  // Overlay chrome is viewport UI. Never shrink it to a host dialog or other
  // overflow box; a tiny modal must not clip or squeeze the editor.
  const visibleClipRect = () => viewportClipRect();
  const placeFixedElement = (node, clientX, clientY, origin = containingBlockOrigin()) => {
    const clip = visibleClipRect();
    const clipWidth = Math.max(0, clip.right - clip.left);
    if (clipWidth > 0) node.style.maxWidth = `${Math.floor(clipWidth)}px`;
    const width = node.offsetWidth;
    const height = node.offsetHeight;
    const minX = clip.left;
    const minY = clip.top;
    const maxX = Math.max(minX, clip.right - width);
    const maxY = Math.max(minY, clip.bottom - height);
    const desiredX = clamp(clientX, minX, maxX);
    const desiredY = clamp(clientY, minY, maxY);
    restoreFixedPosition(node, {left: desiredX, top: desiredY}, origin);
  };
  // A modal dialog makes every node outside it inert. The overlay has to be a
  // descendant to stay clickable, but that is only a hit-testing hook: geometry
  // stays viewport-fixed and must not follow the host dialog's size.
  // Moving an open popover hides it, and CSS enter animations restart on
  // reparent — preserve screen position and do not replay those animations.
  const applyOverlayPlacement = (toolbarRect, popupRect, infoRect) => {
    showOverlayLayer();
    const origin = containingBlockOrigin();
    if (toolbarRect) restoreFixedPosition(root, toolbarRect, origin);
    else placeToolbarDefault(origin);
    if (infoPanel) {
      showAsPopover(infoPanel);
      if (infoRect) placeFixedElement(infoPanel, infoRect.left, infoRect.top, origin);
    }
    if (popup) {
      showAsPopover(popup);
      if (popupRect) placeFixedElement(popup, popupRect.left, popupRect.top, origin);
    }
    refreshComments();
  };
  const syncOverlayHost = () => {
    if (finished) return;
    const host = activeModalHost() || document.documentElement;
    if (overlayLayer.parentElement === host) {
      showOverlayLayer();
      if (infoPanel) showAsPopover(infoPanel);
      if (popup) showAsPopover(popup);
      refreshComments();
      return;
    }
    const toolbarRect = copyRect(root);
    const popupRect = copyRect(popup);
    const infoRect = copyRect(infoPanel);
    hideAsPopover(overlayLayer);
    host.appendChild(overlayLayer);
    applyOverlayPlacement(toolbarRect, popupRect, infoRect);
  };
  let overlayHostSyncFrame = null;
  const scheduleOverlayHostSync = () => {
    if (overlayHostSyncFrame !== null) return;
    overlayHostSyncFrame = requestAnimationFrame(() => {
      overlayHostSyncFrame = null;
      syncOverlayHost();
    });
  };
  const isOverlayMutation = (record) =>
    isOverlay(record.target) ||
    (record.type === 'childList' &&
      [...record.addedNodes, ...record.removedNodes].length > 0 &&
      [...record.addedNodes, ...record.removedNodes].every(isOverlay));
  const modalHostObserver = new MutationObserver((records) => {
    if (records.every(isOverlayMutation)) return;
    scheduleOverlayHostSync();
  });
  modalHostObserver.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['open', 'role', 'aria-modal', 'class', 'style', 'hidden', 'inert']
  });
  // Mutations inside a shadow tree are invisible to an observer attached to
  // the document. Modal activation normally moves focus, so use the composed
  // focus event as the synchronization signal for those components.
  document.addEventListener('focusin', scheduleOverlayHostSync, true);
  syncOverlayHost();
  const esc = (value) => window.CSS && CSS.escape ? CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  const cssPath = (node) => {
    const rootElement = ownerDocumentOf(node).documentElement;
    const parts = [];
    for (let current = node; current && current.nodeType === 1 && current !== rootElement; current = current.parentElement) {
      if (current.id && current.id !== 'steward-review-root') { parts.unshift(`#${esc(current.id)}`); break; }
      let part = current.tagName.toLowerCase();
      const siblings = current.parentElement ? [...current.parentElement.children].filter(item => item.tagName === current.tagName) : [];
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      parts.unshift(part);
    }
    return parts.join(' > ');
  };
  const shadowPath = (node) => {
    const selectors = [];
    let current = node;
    while (isElement(current)) {
      selectors.unshift(cssPath(current));
      const currentRoot = current.getRootNode();
      if (!isShadowRoot(currentRoot)) break;
      current = currentRoot.host;
    }
    return selectors.length > 1 ? selectors : null;
  };
  const resolveSelectorReference = (reference, scopeDocument = document) => {
    if (!scopeDocument) return null;
    const selectors = reference?.shadow_path?.length
      ? reference.shadow_path
      : [reference?.css_selector];
    let scope = scopeDocument;
    let node = null;
    try {
      for (let index = 0; index < selectors.length; index += 1) {
        if (!selectors[index]) return null;
        node = scope.querySelector(selectors[index]);
        if (!node) return null;
        if (index < selectors.length - 1) {
          if (!node.shadowRoot) return null;
          scope = node.shadowRoot;
        }
      }
    } catch {
      return null;
    }
    return node;
  };
  const accessibleFrameDocument = (frame) => {
    try {
      const doc = frame.contentDocument;
      if (!doc) return null;
      void frame.contentWindow?.location?.href;
      return doc;
    } catch {
      return null;
    }
  };
  const selectorReference = (node) => ({
    css_selector: cssPath(node),
    shadow_path: shadowPath(node),
    xpath: xpath(node),
    tag: node.tagName.toLowerCase()
  });
  const iframePath = (node) => {
    const frames = ancestorFramesFor(node);
    if (!frames?.length) return null;
    return frames.slice().reverse().map(selectorReference);
  };
  const resolveIframePath = (path) => {
    if (!path?.length) return document;
    let scopeDocument = document;
    for (const hop of path) {
      const frame = resolveSelectorReference(hop, scopeDocument);
      if (!isFrameElement(frame)) return null;
      scopeDocument = accessibleFrameDocument(frame);
      if (!scopeDocument) return null;
    }
    return scopeDocument;
  };
  const documentForComment = (item) => {
    if (!item?.iframe_path?.length) return document;
    return resolveIframePath(item.iframe_path);
  };
  const toTopClientPoint = (x, y, node, geometry = frameGeometryFor(node)) => mapPointToTop(x, y, geometry);
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
      ...selectorReference(node),
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
  const clearHoverInDocument = (doc) => {
    if (hovered && ownerDocumentOf(hovered) === doc) clearHover();
  };
  const ensureHoverStyle = (node) => {
    const nodeRoot = node.getRootNode();
    if (!isShadowRoot(nodeRoot) || hoverStyleRoots.has(nodeRoot)) return;
    nodeRoot.appendChild(pageStyle.cloneNode(true));
    hoverStyleRoots.add(nodeRoot);
  };
  const clearSelections = () => {
    for (const doc of [...registeredDocuments]) {
      try {
        doc.defaultView?.getSelection()?.removeAllRanges();
      } catch {
        registeredDocuments.delete(doc);
      }
    }
  };
  const setMode = (nextMode) => {
    mode = nextMode;
    addButton.setAttribute('aria-pressed', String(mode === 'element'));
    textButton.setAttribute('aria-pressed', String(mode === 'text'));
    if (mode === 'element') status.textContent = 'Select an element - Esc to exit';
    else if (mode === 'text') status.textContent = 'Select text to comment - Esc to exit';
    else status.textContent = '';
    if (mode !== 'element') clearHover();
    if (mode !== 'text') clearSelections();
  };

  const closeInfo = () => {
    if (infoPanel) {
      hideAsPopover(infoPanel);
      infoPanel.remove();
    }
    infoPanel = null;
    infoButton.setAttribute('aria-expanded', 'false');
  };
  const openInfo = () => {
    closeInfo();
    infoPanel = document.createElement('aside');
    infoPanel.className = 'steward-review-ui steward-review-info';
    infoPanel.setAttribute('popover', 'manual');
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
    overlayShadow.appendChild(infoPanel);
    showAsPopover(infoPanel);

    const buttonRect = infoButton.getBoundingClientRect();
    const left = buttonRect.right - infoPanel.offsetWidth;
    const below = buttonRect.bottom + 10;
    const above = buttonRect.top - infoPanel.offsetHeight - 10;
    const top = below + infoPanel.offsetHeight <= window.innerHeight - 12 ? below : Math.max(12, above);
    placeFixedElement(infoPanel, left, top);
    playEnter(infoPanel);
    infoButton.setAttribute('aria-expanded', 'true');
    infoPanel.querySelector('a').focus({preventScroll: true});
  };
  const toggleInfo = () => infoPanel ? closeInfo() : openInfo();

  // Element and text references are intentionally redundant. Selectors locate
  // the target; text, offsets, and surrounding context disambiguate repeats.
  const endpointReference = (container, offset) => {
    const parent = container.nodeType === 1 ? container : container.parentElement;
    if (!parent || isOverlay(parent)) return null;
    const path = [];
    let current = container;
    while (current !== parent) {
      const parentNode = current.parentNode;
      if (!parentNode) return null;
      path.unshift([...parentNode.childNodes].indexOf(current));
      current = parentNode;
    }
    return {
      parent_css_selector: cssPath(parent),
      parent_shadow_path: shadowPath(parent),
      node_path: path,
      offset
    };
  };
  const surroundingText = (range, commonElement) => {
    const doc = ownerDocumentOf(commonElement);
    const beforeRange = doc.createRange();
    beforeRange.selectNodeContents(commonElement);
    beforeRange.setEnd(range.startContainer, range.startOffset);
    const afterRange = doc.createRange();
    afterRange.selectNodeContents(commonElement);
    afterRange.setStart(range.endContainer, range.endOffset);
    return {
      before: beforeRange.toString().slice(-160),
      after: afterRange.toString().slice(0, 160)
    };
  };
  const rangeReference = (range) => {
    const commonElement = range.commonAncestorContainer.nodeType === 1
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
  const resolveEndpoint = (reference, scopeDocument) => {
    const parent = resolveSelectorReference({
      css_selector: reference.parent_css_selector,
      shadow_path: reference.parent_shadow_path
    }, scopeDocument);
    if (!parent || isOverlay(parent)) return null;
    let node = parent;
    for (const index of reference.node_path || []) {
      node = node.childNodes[index];
      if (!node) return null;
    }
    const maximum = node.nodeType === 3 ? node.data.length : node.childNodes.length;
    if (!Number.isInteger(reference.offset) || reference.offset < 0 || reference.offset > maximum) return null;
    return { node, offset: reference.offset };
  };
  const resolveRange = (selection, scopeDocument = document) => {
    if (!selection?.start || !selection?.end || !scopeDocument) return null;
    const start = resolveEndpoint(selection.start, scopeDocument);
    const end = resolveEndpoint(selection.end, scopeDocument);
    if (!start || !end) return null;
    try {
      const range = ownerDocumentOf(start.node).createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      return range.toString() === selection.selected_text ? range : null;
    } catch {
      return null;
    }
  };
  const resolveElement = (reference, scopeDocument = document) => {
    if (!reference?.css_selector || !scopeDocument) return null;
    const node = resolveSelectorReference(reference, scopeDocument);
    return visible(node) ? node : null;
  };
  const rangeRects = (range) => [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
  const removeHighlight = (id) => {
    for (const node of highlights.get(id) || []) node.remove();
    highlights.delete(id);
  };
  const drawHighlight = (id, range, origin = containingBlockOrigin(), geometry = null) => {
    removeHighlight(id);
    const geo = geometry || frameGeometryFor(range.commonAncestorContainer);
    if (!geo) return [];
    const nodes = rangeRects(range).flatMap(rect => {
      const clipped = mapRectToTop(rect, geo);
      if (!clipped) return [];
      const highlight = document.createElement('div');
      highlight.className = 'steward-review-ui steward-review-highlight';
      const point = toContainingBlock(clipped.left, clipped.top, origin);
      highlight.style.left = `${point.x}px`;
      highlight.style.top = `${point.y}px`;
      highlight.style.width = `${Math.round(clipped.width)}px`;
      highlight.style.height = `${Math.round(clipped.height)}px`;
      shieldReviewUi(highlight);
      overlayShadow.appendChild(highlight);
      return [highlight];
    });
    highlights.set(id, nodes);
    return nodes;
  };
  const clientAnchorForRange = (range, geometry = frameGeometryFor(range.commonAncestorContainer)) => {
    const rects = rangeRects(range);
    const rect = rects.at(-1);
    if (!rect) return null;
    return toTopClientPoint(rect.right, rect.top, range.commonAncestorContainer, geometry);
  };

  const persistableTarget = (draftOrItem) => (
    draftOrItem.iframe_path?.length ? { iframe_path: draftOrItem.iframe_path } : {}
  );
  const commentFromDraft = (draftItem, comment) => ({
    id: draftItem.id, target_type: draftItem.targetType,
    element: draftItem.element, selection: draftItem.selection,
    ...persistableTarget(draftItem),
    anchor: draftItem.anchor, anchor_coordinate_space: draftItem.anchorCoordinateSpace,
    anchor_ratio: draftItem.anchorRatio, comment, created_at: draftItem.created_at
  });
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
      recovered.push(commentFromDraft(draft, text));
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
    if (popup) {
      hideAsPopover(popup);
      popup.remove();
    }
    popup = null;
    draft = null;
    queueDraftSave();
  };
  const updateCount = () => {
    count.textContent = String(comments.length);
    count.dataset.count = String(comments.length);
    count.setAttribute('aria-label', `${comments.length} comment${comments.length === 1 ? '' : 's'}`);
  };
  const hideCommentAnchor = (item) => {
    removeHighlight(item.id);
    return null;
  };
  const anchorForComment = (item, origin = containingBlockOrigin()) => {
    const frameDocument = documentForComment(item);
    if (item.iframe_path?.length && !frameDocument) return hideCommentAnchor(item);
    const fallbackAnchor = () => {
      removeHighlight(item.id);
      if (item.iframe_path?.length || !item.anchor) return null;
      const {x, y} = item.anchor;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      if (item.anchor_coordinate_space === 'viewport') return toContainingBlock(x, y, origin);
      if (item.anchor_coordinate_space) return {x, y};

      // Before coordinate-space metadata existed, document anchors included
      // scroll offsets and modal anchors were relative to their modal host.
      const legacyTarget = resolveSelectorReference(item.element, frameDocument);
      const legacyHost = composedClosest(legacyTarget, MODAL_HOST_SELECTOR);
      if (!legacyHost) return toContainingBlock(x - window.scrollX, y - window.scrollY, origin);
      const hostRect = legacyHost.getBoundingClientRect();
      return toContainingBlock(
        x + hostRect.left + legacyHost.clientLeft - legacyHost.scrollLeft,
        y + hostRect.top + legacyHost.clientTop - legacyHost.scrollTop,
        origin
      );
    };
    if (item.target_type === 'text' && item.selection) {
      const range = resolveRange(item.selection, frameDocument);
      if (!range) return fallbackAnchor();
      const geometry = frameGeometryFor(range.commonAncestorContainer);
      if (!geometry || (geometry.frame && !geometry.clip)) return hideCommentAnchor(item);
      drawHighlight(item.id, range, origin, geometry);
      let lastVisible = null;
      for (const rect of rangeRects(range)) {
        const mapped = mapRectToTop(rect, geometry);
        if (mapped) lastVisible = mapped;
      }
      if (!lastVisible) return geometry.frame ? hideCommentAnchor(item) : renderedAnchors.get(item.id) || fallbackAnchor();
      const point = geometry.frame
        ? clampPinToClip(lastVisible.right, lastVisible.top, lastVisible)
        : { x: lastVisible.right, y: lastVisible.top };
      return point ? toContainingBlock(point.x, point.y, origin) : null;
    }
    if (item.target_type === 'element' && item.anchor_ratio) {
      const target = resolveElement(item.element, frameDocument);
      if (!target) return fallbackAnchor();
      const geometry = frameGeometryFor(target);
      if (!geometry || (geometry.frame && !geometry.clip)) return hideCommentAnchor(item);
      const rect = target.getBoundingClientRect();
      const visibleRect = mapRectToTop(rect, geometry);
      if (!visibleRect) return geometry.frame ? hideCommentAnchor(item) : renderedAnchors.get(item.id) || fallbackAnchor();
      const clientX = rect.left + rect.width * item.anchor_ratio.x;
      const clientY = rect.top + rect.height * item.anchor_ratio.y;
      const mapped = mapPointToTop(clientX, clientY, geometry, false);
      const point = geometry.frame
        ? clampPinToClip(mapped?.x ?? visibleRect.left, mapped?.y ?? visibleRect.top, visibleRect)
        : mapped;
      if (!point) return hideCommentAnchor(item);
      return toContainingBlock(point.x, point.y, origin);
    }
    return fallbackAnchor();
  };
  const ensurePin = (item) => {
    let pin = pins.get(item.id);
    if (pin) return pin;
    pin = document.createElement('button');
    pin.className = 'steward-review-ui steward-review-pin';
    pin.type = 'button';
    pin.hidden = true;
    pin.textContent = String(Math.max(1, comments.indexOf(item) + 1));
    pin.setAttribute('aria-label', `Open comment ${Math.max(1, comments.indexOf(item) + 1)}`);
    shieldReviewUi(pin);
    pin.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); openPopup(item, event.clientX, event.clientY); });
    overlayShadow.appendChild(pin);
    pins.set(item.id, pin);
    return pin;
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
      const item = commentFromDraft(draft, text);
      comments.push(item);
      rememberComment(item);
      refreshComments();
      savedItem = item;
    }
    updateCount();
    draft = { item: savedItem, provisionalId: draft.provisionalId };
    closePopup();
  };
  const openPopup = (item, clientX, clientY, target = null) => {
    closeInfo();
    closePopup();
    popup = document.createElement('div');
    popup.className = 'steward-review-ui steward-review-popup';
    popup.setAttribute('popover', 'manual');
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
    overlayShadow.appendChild(popup);
    showAsPopover(popup);
    draft = item ? { item } : {
      ...target,
      id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
      created_at: new Date().toISOString()
    };
    const placePopup = (nextX, nextY) => placeFixedElement(popup, nextX, nextY);
    placePopup(clientX + 14, clientY + 14);
    playEnter(popup);
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

  comments.forEach(ensurePin);
  updateCount();
  // Toolbar and page event wiring stays together so capture-phase behavior is
  // easy to audit against the host page's own controls.
  const eventOrigin = (event) => event.composedPath().find(isElement) || event.target;
  const ensureDocumentHoverStyle = (doc) => {
    if (!doc) return;
    const rootNode = doc.head || doc.documentElement;
    if (!rootNode || doc.getElementById('steward-review-page-style')) return;
    const style = doc.createElement('style');
    style.id = 'steward-review-page-style';
    style.textContent = pageStyle.textContent;
    rootNode.appendChild(style);
  };
  const onPointerDown = (event) => {
    if (infoPanel && !infoPanel.contains(event.target) && !infoButton.contains(event.target)) closeInfo();
  };
  const onPointerMove = (event) => {
    const target = eventOrigin(event);
    if (target === hovered) return;
    if (mode !== 'element') return;
    if (isOverlay(target) || !visible(target)) {
      clearHover();
      return;
    }
    clearHover();
    hovered = target;
    ensureHoverStyle(hovered);
    hovered.classList.add('steward-review-hover');
  };
  const onClick = (event) => {
    const target = eventOrigin(event);
    if (isOverlay(target)) return;
    if (mode === 'text') {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (mode !== 'element' || !visible(target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const geometry = frameGeometryFor(target);
    const topPoint = toTopClientPoint(event.clientX, event.clientY, target, geometry);
    if (!topPoint) {
      clearHover();
      setMode('interact');
      status.textContent = geometry?.unavailable || 'That element cannot be annotated because its position could not be mapped.';
      return;
    }
    const element = elementReference(target);
    const rect = target.getBoundingClientRect();
    const anchorRatio = {
      x: clamp((event.clientX - rect.left) / rect.width, 0, 1),
      y: clamp((event.clientY - rect.top) / rect.height, 0, 1)
    };
    clearHover();
    setMode('interact');
    openPopup(null, topPoint.x, topPoint.y, {
      targetType: 'element',
      element,
      iframe_path: iframePath(target),
      anchor: {x: topPoint.x, y: topPoint.y},
      anchorCoordinateSpace: 'viewport',
      anchorRatio
    });
  };
  const onPointerUp = (event) => {
    const target = eventOrigin(event);
    if (mode !== 'text' || isOverlay(target)) return;
    const selectionRoot = target.getRootNode?.() || ownerDocumentOf(target);
    const selection = selectionRoot.getSelection?.() || ownerWindowOf(target).getSelection();
    if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) {
      status.textContent = 'Drag across text to select it - Esc to exit';
      return;
    }
    const range = selection.getRangeAt(0).cloneRange();
    const reference = rangeReference(range);
    const geometry = frameGeometryFor(range.commonAncestorContainer);
    if (geometry?.unavailable) {
      status.textContent = geometry.unavailable;
      return;
    }
    const anchor = clientAnchorForRange(range, geometry);
    if (!reference || !reference.selected_text.trim() || !anchor) {
      status.textContent = 'That selection cannot be annotated. Select page text outside the review controls.';
      return;
    }
    const topPoint = toTopClientPoint(event.clientX, event.clientY, target, geometry) || anchor;
    setMode('interact');
    openPopup(null, topPoint.x, topPoint.y, {
      targetType: 'text',
      element: reference.common_ancestor,
      selection: reference,
      iframe_path: iframePath(range.commonAncestorContainer),
      anchor,
      anchorCoordinateSpace: 'viewport',
      range
    });
  };
  const onKeyDown = (event) => {
    if (event.key === 'Escape' && infoPanel) {
      event.preventDefault();
      closeInfo();
      infoButton.focus();
      return;
    }
    if (event.key === 'Escape' && mode !== 'interact') { event.preventDefault(); setMode('interact'); }
  };
  const listenUntilAbort = (target, eventName, listener, options, signal) => {
    if (!target) return;
    target.addEventListener(eventName, listener, options);
    signal?.addEventListener('abort', () => target.removeEventListener(eventName, listener, options), { once: true });
  };
  const bindAnnotationListeners = (doc, signal) => {
    const clearDocumentHover = () => clearHoverInDocument(doc);
    listenUntilAbort(doc, 'pointerdown', onPointerDown, false, signal);
    listenUntilAbort(doc, 'pointermove', onPointerMove, true, signal);
    listenUntilAbort(doc, 'click', onClick, true, signal);
    listenUntilAbort(doc, 'pointerup', onPointerUp, true, signal);
    listenUntilAbort(doc, 'keydown', onKeyDown, true, signal);
    listenUntilAbort(doc.documentElement, 'pointerleave', clearDocumentHover, false, signal);
    // Element scroll events do not bubble, so listen during capture to keep
    // comments anchored when any nested scrollable section moves its content.
    listenUntilAbort(doc, 'scroll', scheduleCommentRefresh, true, signal);
  };
  const attachFrameDocument = (frame) => {
    const nested = accessibleFrameDocument(frame);
    const previous = frameDocuments.get(frame);
    if (previous?.doc === nested) return;
    if (previous) {
      previous.controller.abort();
      releaseFrames(previous.doc);
      registeredDocuments.delete(previous.doc);
      frameDocuments.delete(frame);
      clearHoverInDocument(previous.doc);
    }
    if (!nested) return;
    const Controller = nested.defaultView?.AbortController || AbortController;
    const Observer = nested.defaultView?.MutationObserver || MutationObserver;
    const controller = new Controller();
    try {
      registeredDocuments.add(nested);
      ensureDocumentHoverStyle(nested);
      bindAnnotationListeners(nested, controller.signal);
      listenUntilAbort(nested.defaultView, 'resize', scheduleCommentRefresh, false, controller.signal);
      if (typeof ResizeObserver === 'function') {
        const resizeObserver = new ResizeObserver(scheduleCommentRefresh);
        resizeObserver.observe(frame);
        controller.signal.addEventListener('abort', () => resizeObserver.disconnect(), { once: true });
      }
      const frameDocumentObserver = new Observer((records) => {
        if (records.every(isOverlayMutation)) return;
        for (const record of records) {
          for (const node of record.removedNodes) releaseFrames(node);
          for (const node of record.addedNodes) discoverFrames(node, controller.signal);
        }
        scheduleCommentRefresh();
      });
      frameDocumentObserver.observe(nested, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true
      });
      controller.signal.addEventListener('abort', () => frameDocumentObserver.disconnect(), { once: true });
      nested.fonts?.ready?.then(() => {
        if (!controller.signal.aborted) scheduleCommentRefresh();
      }, () => {});
      frameDocuments.set(frame, { doc: nested, controller });
      discoverFrames(nested, controller.signal);
      scheduleCommentRefresh();
    } catch {
      controller.abort();
      registeredDocuments.delete(nested);
      frameDocuments.delete(frame);
    }
  };
  const watchFrame = (frame) => {
    if (!isFrameElement(frame)) return;
    if (!watchedFrames.has(frame)) {
      watchedFrames.add(frame);
      frame.addEventListener('load', () => attachFrameDocument(frame));
    }
    attachFrameDocument(frame);
  };
  const observeShadowFrames = (root, signal) => {
    if (!isShadowRoot(root) || shadowFrameObservers.has(root)) return;
    const Observer = ownerWindowOf(root).MutationObserver || MutationObserver;
    const observer = new Observer((records) => {
      for (const record of records) {
        for (const node of record.removedNodes) releaseFrames(node);
        for (const node of record.addedNodes) discoverFrames(node, signal);
      }
      scheduleCommentRefresh();
    });
    observer.observe(root, { subtree: true, childList: true });
    shadowFrameObservers.set(root, observer);
    signal?.addEventListener('abort', () => {
      observer.disconnect();
      shadowFrameObservers.delete(root);
    }, { once: true });
  };
  const shadowRootsIn = (node) => {
    const hosts = [];
    if (isElement(node)) hosts.push(node);
    if (node?.querySelectorAll) hosts.push(...node.querySelectorAll('*'));
    return hosts.flatMap((host) => isOverlay(host) || !host.shadowRoot ? [] : [host.shadowRoot]);
  };
  const discoverFrames = (node, signal) => {
    if (isFrameElement(node)) watchFrame(node);
    if (node?.querySelectorAll) {
      for (const frame of node.querySelectorAll('iframe, frame')) watchFrame(frame);
    }
    for (const root of shadowRootsIn(node)) {
      observeShadowFrames(root, signal);
      discoverFrames(root, signal);
    }
  };
  const releaseFrame = (frame) => {
    const tracked = frameDocuments.get(frame);
    if (!tracked) return;
    const nested = tracked.doc;
    tracked.controller.abort();
    registeredDocuments.delete(nested);
    frameDocuments.delete(frame);
    if (nested) releaseFrames(nested);
    scheduleCommentRefresh();
  };
  const releaseFrames = (node) => {
    if (isFrameElement(node)) {
      releaseFrame(node);
      return;
    }
    if (node?.querySelectorAll) {
      for (const frame of node.querySelectorAll('iframe, frame')) releaseFrame(frame);
    }
    for (const root of shadowRootsIn(node)) {
      shadowFrameObservers.get(root)?.disconnect();
      shadowFrameObservers.delete(root);
      releaseFrames(root);
    }
  };
  const frameObserver = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.removedNodes) releaseFrames(node);
      for (const node of record.addedNodes) discoverFrames(node);
    }
  });
  frameObserver.observe(document.documentElement, { subtree: true, childList: true });
  const toggleAnnotationMode = (nextMode) => {
    closeInfo();
    closePopup();
    const entering = mode !== nextMode;
    // Attaching an open shadow root does not emit a DOM mutation. Rescan only
    // when annotation begins so late-created frame trees become interactive
    // without polling or another document-wide observer.
    if (entering) discoverFrames(document);
    setMode(entering ? nextMode : 'interact');
  };
  addButton.addEventListener('click', () => toggleAnnotationMode('element'));
  textButton.addEventListener('click', () => toggleAnnotationMode('text'));
  infoButton.addEventListener('click', toggleInfo);

  refreshComments = () => {
    const origin = containingBlockOrigin();
    for (const item of comments) {
      const pin = ensurePin(item);
      const anchor = anchorForComment(item, origin);
      if (!anchor) {
        pin.hidden = true;
        renderedAnchors.delete(item.id);
        continue;
      }
      const wasHidden = pin.hidden;
      pin.hidden = false;
      if (pin.parentNode !== overlayShadow) overlayShadow.appendChild(pin);
      pin.style.left = `${anchor.x}px`;
      pin.style.top = `${anchor.y}px`;
      renderedAnchors.set(item.id, anchor);
      if (wasHidden && pin.dataset.entered !== 'true') {
        pin.dataset.entered = 'true';
        playEnter(pin);
      }
    }
  };
  scheduleCommentRefresh = () => {
    if (refreshCommentsFrame !== null) return;
    refreshCommentsFrame = requestAnimationFrame(() => {
      refreshCommentsFrame = null;
      refreshComments();
    });
  };
  registeredDocuments.add(document);
  bindAnnotationListeners(document);
  discoverFrames(document);
  refreshComments();
  window.addEventListener('resize', () => {
    closeInfo();
    scheduleCommentRefresh();
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
    const origin = containingBlockOrigin();
    root.style.left = `${rect.left - origin.left}px`;
    root.style.top = `${rect.top - origin.top}px`;
    root.style.transform = 'none';
    const move = (moveEvent) => {
      const left = clamp(moveEvent.clientX - offsetX, 8, window.innerWidth - root.offsetWidth - 8);
      const top = clamp(moveEvent.clientY - offsetY, 8, window.innerHeight - root.offsetHeight - 8);
      root.style.left = `${left - origin.left}px`;
      root.style.top = `${top - origin.top}px`;
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

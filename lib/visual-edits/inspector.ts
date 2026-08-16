export const ELEMENT_SELECTED_TYPE = 'navroop:element-selected';
export const INSPECTOR_ACTIVE_TYPE = 'navroop:inspector-active';
export const INSPECTOR_GLOBAL = '__navroopVisualEdits';
export const INSPECTOR_SCRIPT_ID = 'navroop-visual-edits-inspector';

export type SelectedElementRect = {
  top: number;
  left: number;
  width: number;
  height: number;
};

export type SelectedElementPayload = {
  tagName: string;
  innerText: string;
  selectorPath: string;
  rect: SelectedElementRect;
  hasEditableText: boolean;
};

type InspectorApi = {
  activate: () => void;
  deactivate: () => void;
  __installed?: boolean;
};

export function previewOriginFromUrl(url?: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function isElementSelectedMessage(
  data: unknown,
): data is { type: typeof ELEMENT_SELECTED_TYPE; payload: SelectedElementPayload } {
  if (!data || typeof data !== 'object') return false;
  const record = data as { type?: unknown; payload?: unknown };
  if (record.type !== ELEMENT_SELECTED_TYPE) return false;
  const payload = record.payload;
  if (!payload || typeof payload !== 'object') return false;
  const next = payload as Partial<SelectedElementPayload>;
  return (
    typeof next.tagName === 'string' &&
    typeof next.innerText === 'string' &&
    typeof next.selectorPath === 'string' &&
    Boolean(next.rect) &&
    typeof next.rect === 'object' &&
    typeof next.rect.top === 'number' &&
    typeof next.rect.left === 'number' &&
    typeof next.rect.width === 'number' &&
    typeof next.rect.height === 'number'
  );
}

/**
 * Vanilla JS that runs inside the preview iframe (any stack).
 * Hover uses a fixed overlay — it does not restyle the site's own nodes.
 */
export const INSPECTOR_SCRIPT = `(function () {
  var GLOBAL = ${JSON.stringify(INSPECTOR_GLOBAL)};
  var SELECTED = ${JSON.stringify(ELEMENT_SELECTED_TYPE)};
  var ACTIVE = ${JSON.stringify(INSPECTOR_ACTIVE_TYPE)};
  var HOST_ID = 'navroop-ve-host';
  if (window[GLOBAL] && window[GLOBAL].__installed) return;

  var active = false;
  var host = null;
  var outline = null;
  var capture = null;
  var hovered = null;

  function textOf(el) {
    var raw = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    return raw.slice(0, 100);
  }

  function nthPath(el) {
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.body && node !== document.documentElement) {
      var tag = node.tagName.toLowerCase();
      var parent = node.parentElement;
      if (!parent) break;
      var same = 0;
      var index = 0;
      var child = parent.firstElementChild;
      while (child) {
        if (child.tagName === node.tagName) {
          same += 1;
          if (child === node) index = same;
        }
        child = child.nextElementSibling;
      }
      parts.unshift(tag + ':nth-of-type(' + (index || 1) + ')');
      node = parent;
    }
    return parts.length ? 'body > ' + parts.join(' > ') : 'body';
  }

  function editableText(el) {
    var tag = el.tagName.toLowerCase();
    if (/^(img|svg|video|canvas|iframe|input|textarea|select|hr|br|script|style|path|source)$/.test(tag)) {
      return false;
    }
    var raw = (el.innerText || '').replace(/\\s+/g, ' ').trim();
    if (!raw) return false;
    if (el.childElementCount > 4) return false;
    return raw.length <= 200;
  }

  function skipNode(el) {
    if (!el || el.nodeType !== 1) return true;
    if (el === document.documentElement || el === document.body) return true;
    if (el.id === HOST_ID || (host && host.contains(el))) return true;
    return false;
  }

  function pickFromPoint(x, y) {
    var stack = document.elementsFromPoint(x, y) || [];
    var i;
    for (i = 0; i < stack.length; i += 1) {
      if (!skipNode(stack[i])) return stack[i];
    }
    return null;
  }

  function placeOutline(el) {
    if (!outline || !el) return;
    var rect = el.getBoundingClientRect();
    outline.style.top = rect.top + 'px';
    outline.style.left = rect.left + 'px';
    outline.style.width = Math.max(0, rect.width) + 'px';
    outline.style.height = Math.max(0, rect.height) + 'px';
    outline.style.display = 'block';
  }

  function hideOutline() {
    hovered = null;
    if (outline) outline.style.display = 'none';
  }

  function ensureHost() {
    if (host && host.isConnected) return;
    host = document.getElementById(HOST_ID);
    if (!host) {
      host = document.createElement('div');
      host.id = HOST_ID;
      host.setAttribute('data-navroop-inspector', 'true');
      host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;';
      document.documentElement.appendChild(host);
    }
    outline = host.querySelector('[data-navroop-outline]');
    if (!outline) {
      outline = document.createElement('div');
      outline.setAttribute('data-navroop-outline', 'true');
      outline.style.cssText = [
        'position:fixed',
        'display:none',
        'pointer-events:none',
        'box-sizing:border-box',
        'border:2px solid #e0315a',
        'box-shadow:0 0 0 1px rgba(224,49,90,0.28)',
        'background:rgba(224,49,90,0.06)',
        'border-radius:2px',
      ].join(';');
      host.appendChild(outline);
    }
    capture = host.querySelector('[data-navroop-capture]');
    if (!capture) {
      capture = document.createElement('div');
      capture.setAttribute('data-navroop-capture', 'true');
      capture.style.cssText = 'position:fixed;inset:0;pointer-events:auto;cursor:crosshair;background:transparent;';
      host.appendChild(capture);
    }
  }

  function removeHost() {
    hideOutline();
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = null;
    outline = null;
    capture = null;
  }

  function onMove(event) {
    if (!active) return;
    var el = pickFromPoint(event.clientX, event.clientY);
    hovered = el;
    if (!el) {
      hideOutline();
      return;
    }
    placeOutline(el);
  }

  function preventNav(event) {
    if (!active) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
  }

  function onClick(event) {
    preventNav(event);
    var el = pickFromPoint(event.clientX, event.clientY);
    if (!el) return;
    var rect = el.getBoundingClientRect();
    var payload = {
      tagName: el.tagName.toLowerCase(),
      innerText: textOf(el),
      selectorPath: nthPath(el),
      rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
      hasEditableText: editableText(el),
    };
    window.parent.postMessage({ type: SELECTED, payload: payload }, '*');
  }

  function onScrollOrResize() {
    if (active && hovered) placeOutline(hovered);
  }

  function bindCapture() {
    if (!capture) return;
    capture.addEventListener('mousemove', onMove, true);
    capture.addEventListener('click', onClick, true);
    capture.addEventListener('mousedown', preventNav, true);
    capture.addEventListener('auxclick', preventNav, true);
    capture.addEventListener('contextmenu', preventNav, true);
  }

  function unbindCapture() {
    if (!capture) return;
    capture.removeEventListener('mousemove', onMove, true);
    capture.removeEventListener('click', onClick, true);
    capture.removeEventListener('mousedown', preventNav, true);
    capture.removeEventListener('auxclick', preventNav, true);
    capture.removeEventListener('contextmenu', preventNav, true);
  }

  function activate() {
    if (active) return;
    active = true;
    ensureHost();
    bindCapture();
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
  }

  function deactivate() {
    if (!active && !host) return;
    active = false;
    window.removeEventListener('scroll', onScrollOrResize, true);
    window.removeEventListener('resize', onScrollOrResize);
    unbindCapture();
    removeHost();
  }

  function onParentMessage(event) {
    var data = event.data;
    if (!data || data.type !== ACTIVE) return;
    if (data.active) activate();
    else deactivate();
  }

  window.addEventListener('message', onParentMessage);
  window[GLOBAL] = { activate: activate, deactivate: deactivate, __installed: true };
})();`;

export function injectInspectorIntoIframe(iframe: HTMLIFrameElement): boolean {
  try {
    const win = iframe.contentWindow;
    const doc = iframe.contentDocument;
    if (!win || !doc) return false;

    const existing = (win as Window & { [INSPECTOR_GLOBAL]?: InspectorApi })[INSPECTOR_GLOBAL];
    if (existing?.__installed) return true;

    const prior = doc.getElementById(INSPECTOR_SCRIPT_ID);
    if (prior) prior.remove();

    const script = doc.createElement('script');
    script.id = INSPECTOR_SCRIPT_ID;
    script.textContent = INSPECTOR_SCRIPT;
    (doc.head || doc.documentElement).appendChild(script);

    const installed = (win as Window & { [INSPECTOR_GLOBAL]?: InspectorApi })[INSPECTOR_GLOBAL];
    if (installed?.__installed) return true;

    try {
      const FrameFunction = (win as unknown as { Function: FunctionConstructor }).Function;
      new FrameFunction(INSPECTOR_SCRIPT)();
    } catch {
      return false;
    }
    return Boolean((win as Window & { [INSPECTOR_GLOBAL]?: InspectorApi })[INSPECTOR_GLOBAL]);
  } catch {
    return false;
  }
}

export function setInspectorActive(
  iframe: HTMLIFrameElement,
  active: boolean,
  targetOrigin?: string | null,
): void {
  const origin = targetOrigin && targetOrigin !== 'null' ? targetOrigin : '*';
  try {
    const api = (iframe.contentWindow as (Window & { [INSPECTOR_GLOBAL]?: InspectorApi }) | null)?.[
      INSPECTOR_GLOBAL
    ];
    if (api) {
      if (active) api.activate();
      else api.deactivate();
      return;
    }
  } catch {
    /* cross-origin — fall through to postMessage */
  }
  try {
    iframe.contentWindow?.postMessage({ type: INSPECTOR_ACTIVE_TYPE, active }, origin);
  } catch {
    /* iframe may not be ready */
  }
}

/**
 * Expressions evaluated inside a browser guest.
 *
 * These are strings because they run in the page, not in the server: the only
 * thing that crosses the boundary is JSON. Each is a self-contained IIFE that
 * returns a JSON string, so the caller never has to trust a live object graph
 * from an arbitrary page.
 */

/** Attribute stamped on snapshotted elements so a `ref` is a real selector
 *  rather than a derived CSS path that breaks on the next sibling insert.
 *  Exported because the annotation overlay stamps the same attribute: an element
 *  the user picked and an element an agent snapshotted must have one name. */
export const REF_ATTRIBUTE = 'data-solus-browser-ref'

/** A snapshot ref as an agent may write it: the full selector, or the bare
 *  `e4` that the selector names. Anything else is a selector already. */
export function refSelector(ref: string): string {
  const bare = ref.trim()
  return /^e\d+$/.test(bare) ? `[${REF_ATTRIBUTE}="${bare}"]` : ref
}

/** In-page source: names an element in a few characters (`div#splash`,
 *  `section.toast`), so a report can say what covers another element. */
const DESCRIBE_ELEMENT = `function describeElement(el) {
    const id = el.id ? '#' + el.id : '';
    const className = typeof el.className === 'string' ? el.className.trim().split(/\\s+/)[0] : '';
    return (el.tagName.toLowerCase() + (id || (className ? '.' + className : ''))).slice(0, 60);
  }`

/** In-page source: what covers the centre of an element, or '' when the
 *  element itself (or a child of it) is on top there. */
const COVERED_BY = `function coveredBy(el, rect) {
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    if (typeof document.elementFromPoint !== 'function') return '';
    if (x < 0 || y < 0 || !(x < window.innerWidth) || !(y < window.innerHeight)) return '';
    const hit = document.elementFromPoint(x, y);
    // An ancestor on top means the element does not take pointer events, which
    // is not the same as something else being in front of it.
    if (!hit || hit === el || el.contains(hit) || hit.contains(el)) return '';
    return describeElement(hit);
  }`

/** In-page source: the text a person can read in the viewport, in document
 *  order, up to \`limit\` characters. Text the page draws as dots stays out, as
 *  masked field values do. */
const VISIBLE_TEXT = `function visibleText(limit) {
    if (!document.body || typeof document.createTreeWalker !== 'function') return '';
    const walker = document.createTreeWalker(document.body, 4);
    const parts = [];
    let length = 0;
    let node;
    while (length < limit && (node = walker.nextNode())) {
      const text = (node.nodeValue || '').replace(/\\s+/g, ' ').trim();
      const parent = node.parentElement;
      if (!text || !parent) continue;
      const rect = parent.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || rect.bottom < 0 || rect.top > window.innerHeight) continue;
      const style = window.getComputedStyle(parent);
      if (style.visibility === 'hidden') continue;
      const textSecurity = style.webkitTextSecurity || (style.getPropertyValue ? style.getPropertyValue('-webkit-text-security') : '');
      if (textSecurity && textSecurity !== 'none') continue;
      parts.push(text);
      length += text.length + 3;
    }
    return parts.join(' · ').slice(0, limit).replace(/[\\uD800-\\uDBFF]$/, '');
  }`

/** The global that carries the change watch from a snapshot's structure read
 *  to the read after its screenshot. */
const SNAPSHOT_WATCH = '__solusSnapshotWatch'

/** How much visible text a snapshot carries: enough to read a loading screen,
 *  an error, or a heading, not a whole transcript. */
const SNAPSHOT_TEXT_LIMIT = 1000

/**
 * The elements an agent can act on, plus the labelled landmarks that say where
 * it is. Bounded: an unbounded element list is the fastest way to blow an
 * agent's context on a page it only needed to look at.
 *
 * It also says whether the document is still loading, which text is on screen,
 * and which elements something else covers, and it starts a watch that
 * `snapshotChangesExpression` reads after the screenshot. Without these, a
 * loading screen in front of a mounted app gave a picture of the loading screen
 * and a list of the app's buttons, and nothing said that the two disagreed.
 */
export function elementSnapshotExpression(maxElements: number): string {
  return `(() => {
  const REF = ${JSON.stringify(REF_ATTRIBUTE)};
  const MAX = ${Math.max(1, Math.trunc(maxElements))};
  // A cut must not end on half of a surrogate pair; this code cannot import cutText.
  const LONE_HALF = /[\\uD800-\\uDBFF]$/;
  ${DESCRIBE_ELEMENT}
  ${COVERED_BY}
  ${VISIBLE_TEXT}
  const SELECTOR = 'a[href], button, input, select, textarea, summary, [role], [tabindex], [data-testid], [contenteditable="true"]';
  for (const stale of document.querySelectorAll('[' + REF + ']')) stale.removeAttribute(REF);
  const out = [];
  let seq = 0;
  for (const el of document.querySelectorAll(SELECTOR)) {
    if (out.length >= MAX) break;
    const rect = el.getBoundingClientRect();
    // Zero-area and off-viewport elements are not what the user is looking at,
    // and including them is how a snapshot stops being a description of a view.
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    const ref = 'e' + (++seq);
    el.setAttribute(REF, ref);
    const label = (
      el.getAttribute('aria-label') ||
      (el.getAttribute('aria-labelledby')
        ? (document.getElementById(el.getAttribute('aria-labelledby')) || {}).textContent
        : '') ||
      el.getAttribute('title') ||
      el.getAttribute('placeholder') ||
      (el.textContent || '')
    ).replace(/\\s+/g, ' ').trim().slice(0, 120).replace(LONE_HALF, '');
    const entry = {
      role: el.getAttribute('role') || el.tagName.toLowerCase(),
      label,
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      ref: '[' + REF + '="' + ref + '"]',
    };
    const identifier = el.getAttribute('data-testid') || el.id;
    if (identifier) entry.identifier = identifier;
    if (el.disabled) entry.disabled = true;
    const cover = coveredBy(el, rect);
    if (cover) entry.coveredBy = cover;
    // A value the page masks (a password field, or text the page draws as
    // dots) stays in the page: nothing that reads the snapshot needs it.
    const textSecurity = style.webkitTextSecurity || (style.getPropertyValue ? style.getPropertyValue('-webkit-text-security') : '');
    const isMasked = el.type === 'password' || (!!textSecurity && textSecurity !== 'none');
    if (typeof el.value === 'string' && el.value && !isMasked) entry.value = el.value.slice(0, 200).replace(LONE_HALF, '');
    // Svelte dev mode hangs the authoring location off the node itself, which is
    // how an agent gets file:line for the thing the user is pointing at.
    const meta = el.__svelte_meta && el.__svelte_meta.loc;
    if (meta && meta.file) entry.source = { file: meta.file, line: meta.line || 0, column: meta.column || 0 };
    out.push(entry);
  }
  // Content changes only: the refs stamped above are attributes, and so are
  // the class toggles of hover and focus, which do not change what is shown.
  const prior = window.${SNAPSHOT_WATCH};
  if (prior) prior.observer.disconnect();
  let watching = false;
  if (typeof MutationObserver === 'function' && document.documentElement) {
    const watch = { changes: 0, observer: null };
    watch.observer = new MutationObserver((records) => { watch.changes += records.length; });
    watch.observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    window.${SNAPSHOT_WATCH} = watch;
    watching = true;
  }
  return JSON.stringify({
    title: document.title,
    url: location.href,
    loading: document.readyState === 'loading' || document.readyState === 'interactive',
    visibleText: visibleText(${SNAPSHOT_TEXT_LIMIT}),
    watching,
    elements: out,
  });
})()`
}

/**
 * What changed since `elementSnapshotExpression` read the page: the number of
 * content changes and the URL now. `null` when no watch is on this window,
 * which after a snapshot started one means the document was replaced.
 */
export function snapshotChangesExpression(): string {
  return `(() => {
  const watch = window.${SNAPSHOT_WATCH};
  if (!watch) return JSON.stringify(null);
  watch.observer.disconnect();
  window.${SNAPSHOT_WATCH} = undefined;
  return JSON.stringify({ changes: watch.changes, url: location.href });
})()`
}

/**
 * Wait until the document has loaded and its content has not changed for
 * `quietMs`, or until `timeoutMs`, and say which. A `load` event is not a
 * ready app: a single-page app loads its code, connects, and renders after it.
 * The answer carries the visible text, so a loading screen shows in words.
 */
export function settleExpression(quietMs: number, timeoutMs: number): string {
  return `new Promise((resolve) => {
  ${VISIBLE_TEXT}
  const started = performance.now();
  let changedAt = started;
  const observer = typeof MutationObserver === 'function' && document.documentElement
    ? new MutationObserver(() => { changedAt = performance.now(); })
    : null;
  if (observer) observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  const finish = (settled) => {
    if (observer) observer.disconnect();
    resolve(JSON.stringify({
      settled,
      waitedMs: Math.round(performance.now() - started),
      loading: document.readyState !== 'complete',
      url: location.href,
      title: document.title,
      visibleText: visibleText(300),
    }));
  };
  const check = () => {
    const now = performance.now();
    if (document.readyState === 'complete' && now - changedAt >= ${Math.max(0, Math.trunc(quietMs))}) return finish(true);
    if (now - started >= ${Math.max(0, Math.trunc(timeoutMs))}) return finish(false);
    setTimeout(check, 100);
  };
  check();
})`
}

/**
 * A wait condition as one expression: every condition given must hold. Text
 * is matched in the rendered text of the page, case sensitive; a selector must
 * match an element with a size. A lone `expression` is returned unchanged, so
 * its own value still comes back to the caller.
 */
export function waitConditionExpression(conditions: {
  expression?: string
  text?: string
  selector?: string
  urlIncludes?: string
}): string {
  const checks: string[] = []
  if (conditions.text !== undefined) {
    checks.push(`(!!document.body && document.body.innerText.includes(${JSON.stringify(conditions.text)}))`)
  }
  if (conditions.selector !== undefined) {
    checks.push(`(() => {
    const el = document.querySelector(${JSON.stringify(conditions.selector)});
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  })()`)
  }
  if (conditions.urlIncludes !== undefined) checks.push(`location.href.includes(${JSON.stringify(conditions.urlIncludes)})`)
  if (conditions.expression !== undefined) {
    if (checks.length === 0) return conditions.expression
    checks.push(`!!(${conditions.expression})`)
  }
  return checks.join(' && ')
}

/** Where a selector is on screen, in CSS pixels, after scrolling it into view.
 *  Returns `null` when nothing matches, which is how a drive verb reports a
 *  stale ref instead of clicking an arbitrary point. `coveredBy` names what is
 *  on top of the element's centre, where a click would land instead. */
export function elementRectExpression(selector: string): string {
  return `(() => {
  ${DESCRIBE_ELEMENT}
  ${COVERED_BY}
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return JSON.stringify(null);
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return JSON.stringify(null);
  if (typeof el.focus === 'function') el.focus();
  const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  const cover = coveredBy(el, rect);
  if (cover) point.coveredBy = cover;
  return JSON.stringify(point);
})()`
}

/** The centre of an element in viewport coordinates, or null when it has no
 *  size or its centre is off screen. Unlike `elementRectExpression` it does
 *  not focus: a hover or a drag must not move focus. */
export function visiblePointExpression(selector: string, scroll: boolean): string {
  return `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return JSON.stringify(null);
  if (${scroll}) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const rect = el.getBoundingClientRect();
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  if (rect.width <= 0 || rect.height <= 0 || x < 0 || y < 0 || x > innerWidth || y > innerHeight) return JSON.stringify(null);
  return JSON.stringify({ x, y });
})()`
}

/** Choose options of a native `<select>` by value, else by visible label, and
 *  fire `input` and `change` as a person's choice does. */
export function selectOptionsExpression(selector: string, values: string[]): string {
  return `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return JSON.stringify({ error: 'No element matches that ref.' });
  if (!(el instanceof HTMLSelectElement)) {
    return JSON.stringify({ error: 'That element is not a native <select>. Click a custom dropdown open, then click its option.' });
  }
  const wanted = ${JSON.stringify(values)};
  if (!el.multiple && wanted.length !== 1) return JSON.stringify({ error: 'This <select> takes exactly one option.' });
  const options = Array.from(el.options);
  const chosen = [];
  for (const value of wanted) {
    const option = options.find((o) => o.value === value) ?? options.find((o) => o.label.trim() === value.trim());
    if (!option) {
      const names = options.slice(0, 30).map((o) => o.label.trim()).join(', ');
      return JSON.stringify({ error: 'No option has the value or label ' + JSON.stringify(value) + '. Options: ' + names });
    }
    chosen.push(option);
  }
  for (const option of options) option.selected = chosen.includes(option);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return JSON.stringify({ selected: chosen.map((o) => o.label.trim()) });
})()`
}

/** The `<input type=file>` an upload names: the element itself, the control
 *  of a label, or else the nearest one around the element, as an upload button
 *  usually hides its input beside it. Evaluates to the node, not to JSON. */
export function fileInputExpression(selector: string): string {
  return `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return null;
  const isFileInput = (node) => node instanceof HTMLInputElement && node.type === 'file';
  if (isFileInput(el)) return el;
  if (el instanceof HTMLLabelElement && isFileInput(el.control)) return el.control;
  for (let node = el; node; node = node.parentElement) {
    const found = node.querySelector('input[type=file]');
    if (found) return found;
  }
  return null;
})()`
}

/** Whether a drag from this element is an HTML drag (`draggable`, links and
 *  images by default). Mouse events from CDP do not start one, so the registry
 *  sends the drag events instead. */
export function isHtmlDragSourceExpression(selector: string): string {
  return `(() => {
  for (let node = document.querySelector(${JSON.stringify(selector)}); node; node = node.parentElement) {
    if (node.draggable) return JSON.stringify(true);
  }
  return JSON.stringify(false);
})()`
}

/** An HTML drag from the element to the point, with one shared DataTransfer.
 *  As in a browser, the drop fires only when the target cancels dragover.
 *  Evaluates to whether the target took the drop. */
export function htmlDragExpression(selector: string, to: { x: number; y: number }): string {
  return `(() => {
  const source = document.querySelector(${JSON.stringify(selector)});
  const target = document.elementFromPoint(${to.x}, ${to.y});
  if (!source || !target) return JSON.stringify(false);
  const data = new DataTransfer();
  const rect = source.getBoundingClientRect();
  const fire = (node, type, x, y) => node.dispatchEvent(new DragEvent(type, {
    bubbles: true, cancelable: true, composed: true, dataTransfer: data, clientX: x, clientY: y,
  }));
  fire(source, 'dragstart', rect.x + rect.width / 2, rect.y + rect.height / 2);
  fire(target, 'dragenter', ${to.x}, ${to.y});
  const accepted = !fire(target, 'dragover', ${to.x}, ${to.y});
  if (accepted) fire(target, 'drop', ${to.x}, ${to.y});
  fire(source, 'dragend', ${to.x}, ${to.y});
  return JSON.stringify(accepted);
})()`
}

/** Clear a field before typing into it — `type` with `clear` is one op to the
 *  caller, so the emptying must not need a second round trip. */
export function clearFieldExpression(selector: string): string {
  return `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return JSON.stringify(false);
  if ('value' in el) {
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  } else if (el.isContentEditable) {
    el.textContent = '';
  }
  return JSON.stringify(true);
})()`
}

/**
 * What the browser already measured about this page's load.
 *
 * Nothing here is computed by Solus: the performance timeline exists whether or
 * not anyone reads it, so a snapshot standing in front of a real Chromium at a
 * known viewport can collect Web Vitals for the price of one expression. Each
 * metric is emitted only if it actually happened — a page with no contentful
 * paint yet must read as absent, not as zero, or a regression query would average
 * a fiction.
 *
 * `largest-contentful-paint` and `layout-shift` are read from the timeline
 * buffer rather than through a `PerformanceObserver`, so this stays a synchronous
 * expression. The buffer is bounded, so a page that has shifted more times than
 * it holds reports the shifts it kept — a floor on CLS, never an invention.
 */
export function webVitalsExpression(): string {
  return `(() => {
  const out = {};
  const nav = performance.getEntriesByType('navigation')[0];
  if (nav) {
    if (nav.responseStart > 0) out.ttfbMs = Math.round(nav.responseStart);
    if (nav.domContentLoadedEventEnd > 0) out.domContentLoadedMs = Math.round(nav.domContentLoadedEventEnd);
    if (nav.loadEventEnd > 0) out.loadMs = Math.round(nav.loadEventEnd);
  }
  const fcp = performance.getEntriesByName('first-contentful-paint')[0];
  if (fcp) out.fcpMs = Math.round(fcp.startTime);
  const lcp = performance.getEntriesByType('largest-contentful-paint');
  if (lcp.length) out.lcpMs = Math.round(lcp[lcp.length - 1].startTime);
  const shifts = performance.getEntriesByType('layout-shift');
  if (shifts.length) {
    // Shifts the user caused by interacting are not the page being unstable,
    // which is why the metric excludes them at the source.
    let cls = 0;
    for (const shift of shifts) if (!shift.hadRecentInput) cls += shift.value;
    out.cls = Math.round(cls * 1000) / 1000;
  }
  return JSON.stringify(out);
})()`
}

/** Wrap an author-supplied expression so a throw comes back as a value the
 *  caller can report, rather than as an opaque evaluation failure. */
export function guardedExpression(expression: string): string {
  return `(() => {
  try {
    return JSON.stringify({ ok: true, value: (${expression}) ?? null });
  } catch (err) {
    return JSON.stringify({ ok: false, message: String(err && err.message ? err.message : err) });
  }
})()`
}

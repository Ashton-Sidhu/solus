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

/**
 * The elements an agent can act on, plus the labelled landmarks that say where
 * it is. Bounded: an unbounded element list is the fastest way to blow an
 * agent's context on a page it only needed to look at.
 */
export function elementSnapshotExpression(maxElements: number): string {
  return `(() => {
  const REF = ${JSON.stringify(REF_ATTRIBUTE)};
  const MAX = ${Math.max(1, Math.trunc(maxElements))};
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
    ).replace(/\\s+/g, ' ').trim().slice(0, 120);
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
    if (typeof el.value === 'string' && el.value) entry.value = el.value.slice(0, 200);
    // Svelte dev mode hangs the authoring location off the node itself, which is
    // how an agent gets file:line for the thing the user is pointing at.
    const meta = el.__svelte_meta && el.__svelte_meta.loc;
    if (meta && meta.file) entry.source = { file: meta.file, line: meta.line || 0, column: meta.column || 0 };
    out.push(entry);
  }
  return JSON.stringify({ title: document.title, url: location.href, elements: out });
})()`
}

/** Where a selector is on screen, in CSS pixels, after scrolling it into view.
 *  Returns `null` when nothing matches, which is how a drive verb reports a
 *  stale ref instead of clicking an arbitrary point. */
export function elementRectExpression(selector: string): string {
  return `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return JSON.stringify(null);
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return JSON.stringify(null);
  if (typeof el.focus === 'function') el.focus();
  return JSON.stringify({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
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

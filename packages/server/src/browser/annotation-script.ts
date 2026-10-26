import type { BrowserAnnotateOp, BrowserAnnotationTool } from '@solus/contracts/browser-types'
import { REF_ATTRIBUTE } from './page-script'

/**
 * The annotation overlay, injected into the browser guest.
 *
 * It lives in the page rather than in the client, and that is the whole design:
 * a native `<webview>` paints over the pane, so a client-drawn overlay would be
 * invisible on the surface it exists to annotate, while a streamed canvas has no
 * DOM to hit-test against. One overlay inside the guest serves both — the
 * desktop user draws on it directly, the phone's forwarded taps reach it as
 * ordinary events, and any capture taken while the marks are up contains them.
 *
 * Everything the user marks is held here, in the page, so a reload clears the
 * marks exactly as it clears the page's own state. Nothing is pushed: the pane
 * showing the overlay reads the state back when it needs it.
 */

/** One global on the guest. Named for what it is so a page's own debugging does
 *  not collide with it, and so it is obvious in a console who put it there. */
const GLOBAL = '__solusBrowserAnnotations'

// One colour for every mark: the primary terracotta,
// solid for every stroke and badge. The guest has no `--primary`, so the value
// is a literal. `ON` is the text on a filled badge; `FILL` is a faint wash used
// only for the drag browser, never a committed mark.
const HIGHLIGHT = 'rgb(217, 119, 87)'
const ON_HIGHLIGHT = '#ffffff'
const FILL = 'rgba(217, 119, 87, 0.12)'

/**
 * Install the overlay if it is absent, arm a tool, and report the marks.
 *
 * Idempotent by construction, because it is also the recovery path: the guest
 * navigates and reloads on its own schedule, so the pane simply asks for this
 * again rather than tracking whether the page it is looking at is the one that
 * was instrumented.
 */
export function annotationSyncExpression(tool: BrowserAnnotationTool | null): string {
  return `(() => {
${installerBody()}
  const state = window[${JSON.stringify(GLOBAL)}];
  state.setTool(${JSON.stringify(tool)});
  return state.read();
})()`
}

/** Apply one change to the marks and report the result. The tool stays as it
 *  was: noting a mark is not a reason to disarm the tool that made it. */
export function annotationOpExpression(op: BrowserAnnotateOp): string {
  return `(() => {
${installerBody()}
  const state = window[${JSON.stringify(GLOBAL)}];
  state.apply(${JSON.stringify(op)});
  return state.read();
})()`
}

/**
 * The overlay itself.
 *
 * Pointer handling is capture-phase on the window and stops propagation, so
 * while a tool is armed the page underneath never sees the gesture — a click
 * meant to circle a broken button must not also press it. The overlay element
 * itself never takes pointer events, which is what keeps `document
 * .elementFromPoint` and `event.target` pointing at the real page.
 */
function installerBody(): string {
  return `  if (!window[${JSON.stringify(GLOBAL)}]) {
    const REF = ${JSON.stringify(REF_ATTRIBUTE)};
    const HIGHLIGHT = ${JSON.stringify(HIGHLIGHT)};
    const ON_HIGHLIGHT = ${JSON.stringify(ON_HIGHLIGHT)};
    const FILL = ${JSON.stringify(FILL)};
    const FONT = 'ui-sans-serif, system-ui, sans-serif';
    const MAX_SELECTED_ELEMENTS = 120;
    const state = {
      tool: null,
      annotations: [],
      seq: 0,
      // The click-order counter. Separate from seq (which also numbers element
      // refs), so a mark's number is exactly how many marks were made before it
      // and is never reused after an earlier mark is removed.
      count: 0,
      hover: null,
      pointer: null,
      drag: null,
      browserRegion: null,
      liveScheduled: false,
      // A sent mark drawn again for the reader. Never one of the annotations.
      reveal: null,
      revealScheduled: false,
    };

    const layer = document.createElement('div');
    layer.setAttribute('data-solus-browser-annotations', '');
    layer.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    svg.style.cssText = 'position:absolute;inset:0;overflow:visible;';
    // Two groups, because they are redrawn on completely different schedules.
    // The committed marks change when the user adds or removes one; the live
    // gesture changes on every sampled pointer move. Rebuilding all of the
    // former to move the latter is what made a long freehand stroke slow down
    // as it got longer.
    const marksGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    const liveGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    const revealGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    svg.appendChild(marksGroup);
    svg.appendChild(liveGroup);
    svg.appendChild(revealGroup);
    layer.appendChild(svg);
    // Pick labels and selection counts are HTML, not SVG: their
    // pills use border-radius and box-shadow, which CSS states exactly and SVG
    // only approximates. They sit over the same coordinates as the SVG marks.
    const htmlGroup = document.createElement('div');
    htmlGroup.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
    layer.appendChild(htmlGroup);
    const liveHtmlGroup = document.createElement('div');
    liveHtmlGroup.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
    layer.appendChild(liveHtmlGroup);
    const revealHtmlGroup = document.createElement('div');
    revealHtmlGroup.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
    layer.appendChild(revealHtmlGroup);

    // Chromium draws a PDF in its own viewer frame, which takes every pointer
    // event over it, so none reaches the listeners on this window. While a tool
    // that marks is armed, a transparent layer above the viewer and below the
    // marks takes the pointer instead. It sits outside the body, so a box
    // selection never counts it as page content.
    const inputLayer = document.contentType === 'application/pdf' ? document.createElement('div') : null;
    if (inputLayer) {
      inputLayer.setAttribute('data-solus-browser-annotation-input', '');
      inputLayer.style.cssText = 'position:fixed;inset:0;z-index:2147483646;cursor:crosshair;background:transparent;';
    }

    function syncInputLayer() {
      if (!inputLayer) return;
      // Select hands the page back, so the PDF scrolls and clicks as usual.
      const wanted = Boolean(state.tool) && state.tool !== 'select';
      if (wanted && !inputLayer.isConnected) document.documentElement.appendChild(inputLayer);
      else if (!wanted && inputLayer.isConnected) inputLayer.remove();
    }

    function mount() {
      if (document.body && !layer.isConnected) document.body.appendChild(layer);
    }

    function box(el) {
      const rect = el.getBoundingClientRect();
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    }

    /** The element facts an agent can act on: a stable ref, an accessible name,
     *  and — where the app was built by Svelte in dev mode — the file and line
     *  that produced it, which is what turns a circled button into an edit. */
    function describe(el) {
      let ref = el.getAttribute(REF);
      if (!ref) {
        ref = 'a' + (++state.seq);
        el.setAttribute(REF, ref);
      }
      const label = (
        el.getAttribute('aria-label') ||
        el.getAttribute('title') ||
        el.getAttribute('placeholder') ||
        (el.textContent || '')
      ).replace(/\\s+/g, ' ').trim().slice(0, 120);
      const entry = {
        role: el.getAttribute('role') || el.tagName.toLowerCase(),
        label: label,
        rect: box(el),
        ref: '[' + REF + '="' + ref + '"]',
      };
      const identifier = el.getAttribute('data-testid') || el.id;
      if (identifier) entry.identifier = identifier;
      const meta = el.__svelte_meta && el.__svelte_meta.loc;
      if (meta && meta.file) entry.source = { file: meta.file, line: meta.line || 0, column: meta.column || 0 };
      return entry;
    }

    function bounds(points) {
      let minX = points[0].x, minY = points[0].y, maxX = points[0].x, maxY = points[0].y;
      for (const point of points) {
        if (point.x < minX) minX = point.x;
        if (point.y < minY) minY = point.y;
        if (point.x > maxX) maxX = point.x;
        if (point.y > maxY) maxY = point.y;
      }
      return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }

    /** Measure the page once when a box gesture starts. Pointer movement then
     *  filters plain numbers rather than forcing layout for every element on
     *  every frame. */
    function selectionCandidates() {
      const candidates = [];
      if (!document.body) return candidates;
      for (const el of document.body.querySelectorAll('*')) {
        if (el === layer || layer.contains(el)) continue;
        const measured = el.getBoundingClientRect();
        if (measured.width <= 0 || measured.height <= 0) continue;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        candidates.push({
          el: el,
          rect: {
            x: measured.left,
            y: measured.top,
            width: measured.width,
            height: measured.height,
          },
        });
      }
      return candidates;
    }

    function candidatesInside(rect, candidates) {
      const included = [];
      const right = rect.x + rect.width;
      const bottom = rect.y + rect.height;
      for (const candidate of candidates) {
        if (included.length >= MAX_SELECTED_ELEMENTS) break;
        const measured = candidate.rect;
        if (measured.x < rect.x || measured.y < rect.y) continue;
        if (measured.x + measured.width > right) continue;
        if (measured.y + measured.height > bottom) continue;
        included.push(candidate);
      }
      return included;
    }

    function elementsInside(rect, candidates) {
      return candidatesInside(rect, candidates || selectionCandidates())
        .map((candidate) => describe(candidate.el));
    }

    function elementBounds(elements) {
      const points = [];
      for (const element of elements) {
        points.push({ x: element.rect.x, y: element.rect.y });
        points.push({
          x: element.rect.x + element.rect.width,
          y: element.rect.y + element.rect.height,
        });
      }
      return bounds(points);
    }

    function addSelection(rect, candidates) {
      const elements = elementsInside(rect, candidates);
      if (!elements.length) return;
      add({ tool: 'region', rect: elementBounds(elements), elements: elements });
    }

    function scrollPosition() {
      return { x: Math.round(window.scrollX), y: Math.round(window.scrollY) };
    }

    function add(annotation) {
      annotation.scroll = scrollPosition();
      annotation.id = 'an' + (++state.seq);
      annotation.number = ++state.count;
      annotation.createdAt = Date.now();
      state.annotations.push(annotation);
      render();
    }

    function clear(group) {
      while (group.firstChild) group.removeChild(group.firstChild);
    }

    function stroke(points, width) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      path.setAttribute('points', points.map((p) => p.x + ',' + p.y).join(' '));
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', HIGHLIGHT);
      path.setAttribute('stroke-width', String(width));
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      return path;
    }

    /** An outline around a rect. A pick and every element collected by a box
     *  draw tight to the DOM node. The grouped box gets a dashed outer outline
     *  so its members still read as one selection. */
    function outline(rect, width, dashed) {
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      el.setAttribute('x', String(rect.x));
      el.setAttribute('y', String(rect.y));
      el.setAttribute('width', String(Math.max(1, rect.width)));
      el.setAttribute('height', String(Math.max(1, rect.height)));
      el.setAttribute('fill', 'none');
      el.setAttribute('stroke', HIGHLIGHT);
      el.setAttribute('stroke-width', String(width));
      el.setAttribute('rx', '3');
      if (dashed) el.setAttribute('stroke-dasharray', '4 3');
      return el;
    }

    /** What a pick names: the selector and the measured size, on a tag under the
     *  outlined node — the two facts an agent needs to find the same element in
     *  the source. */
    function pickLabel(annotation) {
      const element = annotation.element || {};
      let selector = element.role || 'element';
      if (element.identifier) selector += '#' + element.identifier;
      else if (element.label) selector += ' · ' + element.label;
      const size = Math.round(annotation.rect.width) + ' × ' + Math.round(annotation.rect.height);
      const tag = document.createElement('div');
      tag.style.cssText =
        'position:absolute;left:' + annotation.rect.x + 'px;top:' + (annotation.rect.y + annotation.rect.height + 6) + 'px;' +
        'max-width:280px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' +
        'padding:2.5px 8px;border-radius:6px;' +
        'background:' + HIGHLIGHT + ';color:' + ON_HIGHLIGHT + ';font:500 10.5px ' + FONT + ';';
      tag.textContent = selector + ' · ' + size;
      return tag;
    }

    function selectionLabel(rect, count) {
      const tag = document.createElement('div');
      tag.style.cssText =
        'position:absolute;left:' + Math.max(4, rect.x) + 'px;top:' + Math.max(4, rect.y - 25) + 'px;' +
        'padding:2.5px 8px;border-radius:6px;' +
        'background:' + HIGHLIGHT + ';color:' + ON_HIGHLIGHT + ';font:600 10.5px ' + FONT + ';' +
        'box-shadow:0 1px 4px rgba(0,0,0,.22);';
      tag.textContent = count === 1 ? '1 element' : count + ' elements';
      return tag;
    }

    /** Everything committed. Called when the set of marks changes, never on a
     *  pointer move. Pick outlines one node, box outlines every selected node,
     *  and freehand is ink. */
    function render() {
      mount();
      clear(marksGroup);
      while (htmlGroup.firstChild) htmlGroup.removeChild(htmlGroup.firstChild);
      for (let i = 0; i < state.annotations.length; i++) {
        const annotation = state.annotations[i];
        if (annotation.tool === 'draw' && annotation.path && annotation.path.length > 1) {
          marksGroup.appendChild(stroke(annotation.path, 3));
        } else if (annotation.tool === 'pick') {
          marksGroup.appendChild(outline(annotation.rect, 1.5, false));
          htmlGroup.appendChild(pickLabel(annotation));
        } else if (annotation.elements && annotation.elements.length) {
          marksGroup.appendChild(outline(annotation.rect, 1.5, true));
          for (const element of annotation.elements) {
            marksGroup.appendChild(outline(element.rect, 1.5, false));
          }
          htmlGroup.appendChild(selectionLabel(annotation.rect, annotation.elements.length));
        }
      }
      renderLive();
    }

    function pinBadge(rect, pin) {
      const tag = document.createElement('div');
      tag.style.cssText =
        'position:absolute;left:' + Math.max(4, rect.x - 9) + 'px;top:' + Math.max(4, rect.y - 9) + 'px;' +
        'min-width:18px;height:18px;padding:0 5px;box-sizing:border-box;border-radius:9px;' +
        'display:flex;align-items:center;justify-content:center;' +
        'background:' + HIGHLIGHT + ';color:' + ON_HIGHLIGHT + ';font:600 10.5px ' + FONT + ';' +
        'box-shadow:0 1px 4px rgba(0,0,0,.22);';
      tag.textContent = String(pin);
      return tag;
    }

    /** The element a sent pick named, if this page still has it: the ref while
     *  the page has not reloaded, then the test id or id it was named by. */
    function revealElement(mark) {
      if (mark.tool !== 'pick') return null;
      const byRef = mark.ref ? document.querySelector(mark.ref) : null;
      if (byRef || !mark.identifier) return byRef;
      for (const el of document.querySelectorAll('[data-testid]')) {
        if (el.getAttribute('data-testid') === mark.identifier) return el;
      }
      return document.getElementById(mark.identifier);
    }

    /** A sent mark, drawn where it is now. An element is measured again; a
     *  stroke or a box is moved by however far the page scrolled since. */
    function renderReveal() {
      clear(revealGroup);
      while (revealHtmlGroup.firstChild) revealHtmlGroup.removeChild(revealHtmlGroup.firstChild);
      const reveal = state.reveal;
      if (!reveal) return;
      mount();
      const mark = reveal.mark;
      if (reveal.element && reveal.element.isConnected) {
        const rect = box(reveal.element);
        revealGroup.appendChild(outline(rect, 2, false));
        revealHtmlGroup.appendChild(pinBadge(rect, mark.pin));
        return;
      }
      const dx = reveal.anchor.x - window.scrollX;
      const dy = reveal.anchor.y - window.scrollY;
      const rect = { x: mark.rect.x + dx, y: mark.rect.y + dy, width: mark.rect.width, height: mark.rect.height };
      if (mark.tool === 'draw' && mark.path && mark.path.length > 1) {
        revealGroup.appendChild(stroke(mark.path.map((p) => ({ x: p.x + dx, y: p.y + dy })), 3));
      } else {
        revealGroup.appendChild(outline(rect, 2, mark.tool === 'region'));
      }
      revealHtmlGroup.appendChild(pinBadge(rect, mark.pin));
    }

    function scheduleReveal() {
      if (state.revealScheduled) return;
      state.revealScheduled = true;
      window.requestAnimationFrame(() => {
        state.revealScheduled = false;
        renderReveal();
      });
    }

    function hideReveal() {
      if (!state.reveal) return;
      state.reveal = null;
      renderReveal();
    }

    /** Bring a sent mark into view and draw it. Scrolling is instant: the
     *  reader asked to be taken there, not to watch the page travel. */
    function showReveal(mark) {
      const element = revealElement(mark);
      if (element) {
        element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
        state.reveal = { mark: mark, element: element, anchor: scrollPosition() };
      } else {
        if (mark.scroll) window.scrollTo({ left: mark.scroll.x, top: mark.scroll.y, behavior: 'instant' });
        state.reveal = { mark: mark, element: null, anchor: mark.scroll || scrollPosition() };
      }
      renderReveal();
    }

    /**
     * The gesture in progress: what is under the pointer, and the stroke or
     * rectangle being drawn right now. A box also outlines each element that
     * would be included if the pointer were released on this frame.
     *
     * Redrawn rather than stored, so nothing half-finished can survive as a
     * mark — and redrawn on its own, so a hundred-point stroke costs one
     * polyline per move instead of the whole overlay.
     */
    function renderLive() {
      clear(liveGroup);
      while (liveHtmlGroup.firstChild) liveHtmlGroup.removeChild(liveHtmlGroup.firstChild);
      const live = state.drag && state.drag.points
        ? { path: state.drag.points, rect: bounds(state.drag.points) }
        : state.drag
          ? {
              rect: bounds([state.drag.from, state.drag.to]),
              candidates: state.drag.candidates,
            }
          : state.browserRegion
            ? state.browserRegion
            : state.hover
              ? { rect: state.hover }
              : null;
      if (!live) return;
      if (live.path) {
        // A single point is a stroke that has started but not moved. Drawing it
        // as a dot rather than nothing is what tells the user the pen is down.
        if (live.path.length > 1) liveGroup.appendChild(stroke(live.path, 3));
        else {
          const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
          dot.setAttribute('cx', String(live.path[0].x));
          dot.setAttribute('cy', String(live.path[0].y));
          dot.setAttribute('r', '1.5');
          dot.setAttribute('fill', HIGHLIGHT);
          liveGroup.appendChild(dot);
        }
        return;
      }
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', String(live.rect.x));
      rect.setAttribute('y', String(live.rect.y));
      rect.setAttribute('width', String(Math.max(1, live.rect.width)));
      rect.setAttribute('height', String(Math.max(1, live.rect.height)));
      rect.setAttribute('fill', FILL);
      rect.setAttribute('stroke', HIGHLIGHT);
      rect.setAttribute('stroke-width', '1.5');
      rect.setAttribute('stroke-dasharray', '4 3');
      liveGroup.appendChild(rect);
      if (live.candidates) {
        const included = candidatesInside(live.rect, live.candidates);
        for (const candidate of included) {
          liveGroup.appendChild(outline(candidate.rect, 1.5, false));
        }
        liveHtmlGroup.appendChild(selectionLabel(live.rect, included.length));
      }
    }

    /** Pointer events can arrive faster than the display paints. Box feedback
     *  is limited to one DOM update per animation frame, while the element
     *  measurements themselves were already cached on pointerdown. */
    function scheduleLive() {
      if (state.liveScheduled) return;
      state.liveScheduled = true;
      window.requestAnimationFrame(() => {
        state.liveScheduled = false;
        renderLive();
      });
    }

    function target(event) {
      let el = document.elementFromPoint(event.clientX, event.clientY);
      // The PDF input layer is not page content; what lies under it is.
      if (inputLayer && el === inputLayer) {
        el = document.elementsFromPoint(event.clientX, event.clientY).find((candidate) => candidate !== inputLayer) || null;
      }
      return el && el !== document.documentElement && el !== document.body ? el : null;
    }

    function hit(x, y) {
      for (let i = state.annotations.length - 1; i >= 0; i--) {
        const rect = state.annotations[i].rect;
        if (x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height) {
          return state.annotations[i];
        }
      }
      return null;
    }

    function onDown(event) {
      // The select tool hands the page back: the overlay stays up and the marks stay
      // visible, but the pointer goes where it was aimed. It is how a user
      // clicks through a flow without losing what they have already marked.
      if (!state.tool || state.tool === 'select') return;
      event.preventDefault();
      event.stopPropagation();
      if (state.tool === 'pick') {
        const el = target(event);
        if (el) add({ tool: 'pick', rect: box(el), element: describe(el) });
        return;
      }
      if (state.tool === 'erase') {
        const found = hit(event.clientX, event.clientY);
        if (found) {
          state.annotations = state.annotations.filter((a) => a !== found);
          render();
        }
        return;
      }
      const point = { x: Math.round(event.clientX), y: Math.round(event.clientY) };
      state.drag = state.tool === 'draw'
        ? { points: [point] }
        : {
            tool: state.tool,
            from: point,
            to: point,
            candidates: selectionCandidates(),
          };
      renderLive();
    }

    function onMove(event) {
      if (!state.tool || state.tool === 'select') return;
      event.stopPropagation();
      if (state.drag && state.drag.points) {
        const last = state.drag.points[state.drag.points.length - 1];
        // Sampled by distance: a pointer reports far more often than a legible
        // stroke needs, and every extra point is one more the prompt carries.
        if (Math.abs(event.clientX - last.x) + Math.abs(event.clientY - last.y) >= 3) {
          state.drag.points.push({ x: Math.round(event.clientX), y: Math.round(event.clientY) });
          scheduleLive();
        }
        return;
      }
      if (state.drag) {
        state.drag.to = { x: Math.round(event.clientX), y: Math.round(event.clientY) };
        scheduleLive();
        return;
      }
      if (state.tool === 'pick') {
        state.pointer = { clientX: event.clientX, clientY: event.clientY };
        updateHover();
      }
    }

    /** Outline the element under the last pointer position. A scroll moves the
     *  page under a still pointer without a pointer event, so the scroll
     *  handler calls this too. */
    function updateHover() {
      if (state.tool !== 'pick' || state.drag || !state.pointer) return;
      const el = target(state.pointer);
      const next = el ? box(el) : null;
      const same = next && state.hover
        && next.x === state.hover.x && next.y === state.hover.y
        && next.width === state.hover.width && next.height === state.hover.height;
      if (same || (!next && !state.hover)) return;
      state.hover = next;
      renderLive();
    }

    function onUp(event) {
      if (!state.tool || !state.drag) return;
      event.preventDefault();
      event.stopPropagation();
      const drag = state.drag;
      state.drag = null;
      if (drag.points) {
        if (drag.points.length > 1) add({ tool: 'draw', rect: bounds(drag.points), path: drag.points });
      } else {
        const rect = bounds([drag.from, drag.to]);
        // A click that never moved is not a selection, and a box with no fully
        // contained elements selects nothing.
        if (rect.width > 4 && rect.height > 4) addSelection(rect, drag.candidates);
      }
      render();
    }

    // A revealed mark is there to be found, then out of the way: the next touch
    // or key on the page puts it away.
    window.addEventListener('pointerdown', hideReveal, true);
    window.addEventListener('keydown', hideReveal, true);
    // Capture phase, so the page never sees a gesture meant for the overlay.
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    // A stroke that ends off the edge of the guest is a stroke the user finished
    // — the browser simply stops telling us about it. Without these the drag
    // stays live forever, and the next press continues the abandoned stroke from
    // wherever it was left.
    window.addEventListener('pointercancel', onUp, true);
    window.addEventListener('blur', () => {
      if (!state.drag) return;
      onUp({ preventDefault() {}, stopPropagation() {} });
    });
    // A click is dispatched after pointerup and would otherwise reach the page
    // anyway — the one event that would make circling a button also press it.
    window.addEventListener('click', (event) => {
      if (!state.tool) return;
      event.preventDefault();
      event.stopPropagation();
    }, true);
    // Marks are in viewport coordinates, so anything that moves the page under
    // them invalidates every DOM-backed rect. Picks and box selections can be
    // measured again; freehand stays where the user put it.
    window.addEventListener('scroll', () => {
      if (state.reveal) scheduleReveal();
      updateHover();
      if (!state.annotations.length) return;
      for (const annotation of state.annotations) {
        if (annotation.element) {
          const el = document.querySelector(annotation.element.ref);
          if (el) {
            annotation.element = describe(el);
            annotation.rect = annotation.element.rect;
            annotation.scroll = scrollPosition();
          }
        }
        if (annotation.elements) {
          const elements = [];
          for (const selected of annotation.elements) {
            const el = document.querySelector(selected.ref);
            if (el) elements.push(describe(el));
          }
          annotation.elements = elements;
          if (elements.length) {
            annotation.rect = elementBounds(elements);
            annotation.scroll = scrollPosition();
          }
        }
      }
      render();
    }, true);

    state.setTool = function (tool) {
      // Re-arming the tool that is already armed must change nothing. The pane
      // polls the marks twice a second while a tool is armed, and that read
      // re-arms on the way in so a reloaded page gets its overlay back — so a
      // setTool that reset the gesture state would wipe the half-drawn stroke
      // or the half-dragged region under the user's own hand, every 500ms.
      // Freehand was unusable for exactly this reason.
      if (state.tool === tool) return;
      state.tool = tool;
      hideReveal();
      state.hover = null;
      state.pointer = null;
      state.drag = null;
      state.browserRegion = null;
      // The cursor is the only thing that says a tool is armed once the pointer
      // is over the page rather than over the pane's toolbar.
      layer.style.cursor = tool === 'pick' ? 'crosshair' : tool ? 'crosshair' : 'default';
      syncInputLayer();
      render();
    };

    state.apply = function (op) {
      if (op.kind === 'reveal') {
        showReveal(op);
        return;
      }
      if (op.kind === 'clear') {
        state.annotations = [];
        state.browserRegion = null;
        render();
        return;
      }
      if (op.kind === 'remove') {
        state.annotations = state.annotations.filter((a) => a.id !== op.annotationId);
        render();
        return;
      }
      if (op.kind === 'browserRegion') {
        if (!op.rect) {
          state.browserRegion = null;
          renderLive();
          return;
        }
        const candidates = state.browserRegion
          ? state.browserRegion.candidates
          : selectionCandidates();
        state.browserRegion = { rect: op.rect, candidates: candidates };
        if (op.commit) {
          state.browserRegion = null;
          addSelection(op.rect, candidates);
        } else {
          renderLive();
        }
        return;
      }
      if (op.kind === 'mark') {
        // A gesture a client tracked itself, because its surface is a picture it
        // cannot receive a drag on. Held to the same rules the pointer path
        // applies, so a stray tap forwarded as a mark is dropped here rather
        // than becoming an invisible entry in the prompt.
        if (op.tool === 'draw') {
          if (op.path && op.path.length > 1) add({ tool: 'draw', rect: bounds(op.path), path: op.path });
          return;
        }
        state.browserRegion = null;
        if (op.rect && op.rect.width > 4 && op.rect.height > 4) addSelection(op.rect);
        else renderLive();
        return;
      }
      if (op.kind === 'note') {
        for (const annotation of state.annotations) {
          if (annotation.id === op.annotationId) annotation.note = op.note;
        }
        return;
      }
    };

    state.read = function () {
      return JSON.stringify({
        annotations: state.annotations.map((annotation) => {
          const copy = {
            id: annotation.id,
            tool: annotation.tool,
            rect: annotation.rect,
            createdAt: annotation.createdAt,
            number: annotation.number,
          };
          if (annotation.path) copy.path = annotation.path;
          if (annotation.scroll) copy.scroll = annotation.scroll;
          if (annotation.element) copy.element = annotation.element;
          if (annotation.elements) copy.elements = annotation.elements;
          if (annotation.note) copy.note = annotation.note;
          return copy;
        }),
      });
    };

    window[${JSON.stringify(GLOBAL)}] = state;
    mount();
  }`
}

import { z } from 'zod'

const MAX_OPTIONS = 500
const MAX_LABEL_LENGTH = 150

export const selectMenuProbeSchema = z.union([
  z.null(),
  z.literal(false),
  z.object({
    options: z.array(z.object({ label: z.string().max(MAX_LABEL_LENGTH), disabled: z.boolean() })).min(1).max(MAX_OPTIONS),
    selectedIndex: z.number().int().min(-1).max(MAX_OPTIONS - 1),
    x: z.number(),
    y: z.number(),
    width: z.number().positive(),
    height: z.number().positive(),
  }),
])

// One bounded guest slot. Weak references let removed options and frames go even
// if the viewer leaves before answering. The registry owns the right to answer.
const SLOT = 'Symbol.for("solus.streamedSelectMenu")'
const IS_DROPDOWN = `(select) => select?.tagName === 'SELECT' && !select.multiple && select.size <= 1 &&
  !select.matches(':disabled') &&
  !(select.ownerDocument.defaultView.getComputedStyle(select).appearance === 'base-select' &&
    select.ownerDocument.defaultView.getComputedStyle(select, '::picker(select)').appearance === 'base-select')`
const IS_SHOWN = `(element) => !element.hidden && element.ownerDocument.defaultView.getComputedStyle(element).display !== 'none'`

/** null forwards the normal click. False means page handlers ran but no menu opened. */
export function probeSelectMenuExpression(id: string, x: number, y: number): string {
  return `JSON.stringify((() => {
    const slot = ${SLOT};
    delete window[slot];
    let root = document;
    let x = ${JSON.stringify(x)}, y = ${JSON.stringify(y)};
    let offsetX = 0, offsetY = 0;
    const frames = [];
    let target;
    while ((target = root.elementFromPoint(x, y))) {
      if (target.shadowRoot && target.shadowRoot !== root) {
        root = target.shadowRoot;
        continue;
      }
      if (target.tagName !== 'IFRAME' && target.tagName !== 'FRAME') break;
      const doc = target.contentDocument;
      if (!doc) return null;
      // Subtract frame borders and padding only when the axes are unchanged.
      for (let node = target; node; node = node.parentElement ?? node.getRootNode().host) {
        const style = node.ownerDocument.defaultView.getComputedStyle(node);
        if (style.transform !== 'none' || style.rotate !== 'none' || style.scale !== 'none' ||
            style.translate !== 'none' || style.perspective !== 'none' || Number(style.zoom) !== 1) return null;
      }
      const rect = target.getBoundingClientRect();
      const style = target.ownerDocument.defaultView.getComputedStyle(target);
      const dx = rect.left + target.clientLeft + (parseFloat(style.paddingLeft) || 0);
      const dy = rect.top + target.clientTop + (parseFloat(style.paddingTop) || 0);
      x -= dx; y -= dy; offsetX += dx; offsetY += dy;
      frames.push({ frame: new WeakRef(target), document: new WeakRef(doc), url: doc.URL });
      root = doc;
    }
    const select = target?.closest('select');
    const isDropdown = ${IS_DROPDOWN};
    if (!isDropdown(select) || select.options.length > ${MAX_OPTIONS}) return null;
    const view = select.ownerDocument.defaultView;
    const dispatch = (type, EventClass, buttons) => target.dispatchEvent(new EventClass(type, {
      bubbles: true, cancelable: true, composed: true, view, button: 0, buttons, clientX: x, clientY: y,
      pointerId: 1, pointerType: 'mouse', isPrimary: true, detail: 1,
    }));
    // A trusted press opens an OS popup outside the stream. Let the page's
    // handlers run before describing the select, including options made on click.
    if (!dispatch('pointerdown', view.PointerEvent, 1)) {
      dispatch('pointerup', view.PointerEvent, 0);
      return false;
    }
    const pressed = dispatch('mousedown', view.MouseEvent, 1);
    if (pressed && select.isConnected) select.focus({ preventScroll: true });
    dispatch('pointerup', view.PointerEvent, 0);
    dispatch('mouseup', view.MouseEvent, 0);
    const clicked = dispatch('click', view.PointerEvent, 0);
    if (!pressed || !clicked || !select.isConnected || !isDropdown(select) || select.options.length > ${MAX_OPTIONS}) return false;
    const shown = ${IS_SHOWN};
    const options = Array.from(select.options).filter((option) =>
      shown(option) && (option.parentElement.tagName !== 'OPTGROUP' || shown(option.parentElement)));
    const { left, top, width, height } = select.getBoundingClientRect();
    if (!options.length || !width || !height) return false;
    const disabled = options.map((option) => option.matches(':disabled'));
    window[slot] = {
      id: ${JSON.stringify(id)}, url: document.URL, frames, select: new WeakRef(select),
      options: options.map((option) => new WeakRef(option)), disabled,
    };
    return {
      options: options.map((option, index) => ({ label: option.label.slice(0, ${MAX_LABEL_LENGTH}), disabled: disabled[index] })),
      selectedIndex: options.indexOf(select.options[select.selectedIndex]),
      x: left + offsetX, y: top + offsetY, width, height,
    };
  })())`
}

export function answerSelectMenuExpression(id: string, index: number | null): string {
  return `JSON.stringify((() => {
    const slot = ${SLOT};
    const menu = window[slot];
    if (menu?.id !== ${JSON.stringify(id)}) return false;
    delete window[slot];
    const index = ${JSON.stringify(index)};
    if (index === null) return true;
    if (menu.url !== document.URL || menu.frames.some((entry) => {
      const frame = entry.frame.deref();
      const doc = entry.document.deref();
      return !frame?.isConnected || !doc || frame.contentDocument !== doc || doc.URL !== entry.url;
    })) return false;
    const option = menu.options[index]?.deref();
    const select = menu.select.deref();
    const isDropdown = ${IS_DROPDOWN};
    const shown = ${IS_SHOWN};
    if (!option?.isConnected || !select?.isConnected || option.closest('select') !== select ||
        !isDropdown(select) || !select.getClientRects().length || menu.disabled[index] ||
        option.matches(':disabled') || !shown(option) ||
        (option.parentElement.tagName === 'OPTGROUP' && !shown(option.parentElement))) return false;
    if (!option.selected) {
      option.selected = true;
      const Event = select.ownerDocument.defaultView.Event;
      select.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return true;
  })())`
}

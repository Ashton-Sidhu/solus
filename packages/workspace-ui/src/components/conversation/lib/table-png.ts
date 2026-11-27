/*
Adapted from https://github.com/pingdotgg/t3code/pull/43435.

MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

import { paintOps, type Box, type DrawOp } from "./table-png-paint";

/*
 * Paints a rendered table onto a canvas from the layout the browser has already computed: one
 * read pass over the table (computed styles and client rects, no DOM writes), then plain canvas
 * draws and an asynchronous PNG encode. Nothing is cloned, no styles are inlined, and nothing is
 * laid out a second time, as an SVG <foreignObject> snapshot would.
 */

/** Space around the table, in CSS pixels, so the outer columns are not cut at the image edge. */
const MARGIN = 16;
const MAX_SCALE = 3;
/** iOS Safari's canvas area limit. A larger table is drawn at a lower scale to fit. */
const MAX_CANVAS_AREA = 16_777_216;
const MAX_CANVAS_SIDE = 16_384;
const ELLIPSIS = "…";
/** Stands in for "no clip" on the axis an `overflow-x`/`overflow-y` box leaves visible. */
const UNBOUNDED = 1e6;
const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";

interface Ellipsis {
  /** The content edge that text must not cross. */
  readonly right: number;
  done: boolean;
}

interface Scope {
  readonly style: CSSStyleDeclaration;
  readonly alpha: number;
  /** Inside an inline-level box: painted with the text, after every block background. */
  readonly inline: boolean;
  /** Decorations propagate to descendant text without being inherited in computed style. */
  readonly decorations: readonly CSSStyleDeclaration[];
  readonly ellipsis: Ellipsis | null;
}

const PRESERVED_SPACES = /^(?:pre|pre-wrap|break-spaces)$/;

function isTransparent(color: string): boolean {
  return color === "transparent" || /^rgba\(.*,\s*0\)$/.test(color);
}

function isOpaque(color: string): boolean {
  return !color.startsWith("rgba(") && !color.includes("/");
}

function canvasFont(style: CSSStyleDeclaration): string {
  // Canvas fonts take a keyword for oblique, not an angle.
  const fontStyle = style.fontStyle.startsWith("oblique") ? "oblique" : style.fontStyle;
  return `${fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
}

function transformText(text: string, transform: string): string {
  if (transform === "uppercase") return text.toUpperCase();
  if (transform === "lowercase") return text.toLowerCase();
  if (transform === "capitalize")
    return text.replace(
      /(^|\s)(\p{L})/gu,
      (_, space: string, letter: string) => space + letter.toUpperCase(),
    );
  return text;
}

function cornerRadius(value: string, box: Box): number {
  const radius = Number.parseFloat(value) || 0;
  return value.endsWith("%") ? (Math.min(box.width, box.height) * radius) / 100 : radius;
}

function isHidden(style: CSSStyleDeclaration): boolean {
  // This also excludes visually hidden labels inside inline controls.
  return style.display === "none" || style.clipPath !== "none" ||
    (style.clip !== "" && style.clip !== "auto");
}

function inheritedEllipsis(right: number | null | undefined, parent: Scope | null): Ellipsis | null {
  return right == null ? parent?.ellipsis ?? null : { right, done: false };
}

function textDecorations(style: CSSStyleDeclaration, parent: Scope | null) {
  const inherited = parent?.decorations ?? [];
  return style.textDecorationLine === "none" ? inherited : [...inherited, style];
}

/** Copies a rendered `<table>` (and the backdrop behind it) into a PNG. */
export async function renderTablePng(table: HTMLTableElement): Promise<Blob> {
  // A detached table measures 0 x 0 and would copy an empty image over the clipboard.
  if (!table.isConnected) throw new Error("The table left the page before it was drawn.");
  const document = table.ownerDocument;
  const view = document.defaultView;
  if (!view) throw new Error("The table has no window.");
  // Measure the table itself. The scroll wrapper clips it on screen only.
  const bounds = table.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) throw new Error("The table has no layout.");
  const width = bounds.width + MARGIN * 2;
  const height = bounds.height + MARGIN * 2;
  const scale = Math.min(
    Math.max(view.devicePixelRatio || 1, 1),
    MAX_SCALE,
    MAX_CANVAS_SIDE / width,
    MAX_CANVAS_SIDE / height,
    Math.sqrt(MAX_CANVAS_AREA / (width * height)),
  );
  // Rounding down keeps the canvas inside both caps; at most a pixel of margin is lost.
  const pixelWidth = Math.max(1, Math.floor(width * scale));
  const pixelHeight = Math.max(1, Math.floor(height * scale));
  const canvas = globalThis.OffscreenCanvas
    ? new OffscreenCanvas(pixelWidth, pixelHeight)
    : document.createElement("canvas");
  canvas.width = pixelWidth;
  canvas.height = pixelHeight;
  const context = canvas.getContext("2d");
  if (!context || !("fillRect" in context)) throw new Error("A canvas is unavailable for the table image.");

  const originX = bounds.left - MARGIN;
  const originY = bounds.top - MARGIN;
  const toBox = (rect: DOMRect): Box => ({
    x: rect.left - originX,
    y: rect.top - originY,
    width: rect.width,
    height: rect.height,
  });

  // CSS paints block backgrounds and borders before inline content, whatever the tree order.
  const blockOps: DrawOp[] = [];
  const contentOps: DrawOp[] = [];
  const objectUrls: string[] = [];
  const range = document.createRange();
  const fontMetrics = new Map<string, { ascent: number; descent: number }>();
  let graphemes: Intl.Segmenter | undefined;

  const metricsFor = (font: string) => {
    let metrics = fontMetrics.get(font);
    if (!metrics) {
      context.font = font;
      const measured = context.measureText("x");
      metrics = {
        ascent: measured.fontBoundingBoxAscent,
        descent: measured.fontBoundingBoxDescent,
      };
      fontMetrics.set(font, metrics);
    }
    return metrics;
  };

  /** A text rect is its line box or its content area; the baseline sits the same in both. */
  const baselineIn = (rect: DOMRect, font: string) => {
    const { ascent, descent } = metricsFor(font);
    return rect.top - originY + (rect.height - ascent - descent) / 2 + ascent;
  };

  const paintBox = (rect: DOMRect, style: CSSStyleDeclaration, alpha: number, ops: DrawOp[]) => {
    const box = toBox(rect);
    if (box.width <= 0 || box.height <= 0) return;
    const radius = cornerRadius(style.borderTopLeftRadius, box);
    if (!isTransparent(style.backgroundColor)) {
      ops.push({ kind: "fill", box, color: style.backgroundColor, radius, alpha });
    }
    const sides = (["Top", "Right", "Bottom", "Left"] as const).map((side) => ({
      side,
      width:
        style[`border${side}Style`] === "none" || style[`border${side}Style`] === "hidden"
          ? 0
          : Number.parseFloat(style[`border${side}Width`]) || 0,
      color: style[`border${side}Color`],
    }));
    const [first] = sides;
    if (
      radius > 0 &&
      first &&
      sides.every((side) => side.width === first.width && side.color === first.color)
    ) {
      if (first.width > 0 && !isTransparent(first.color)) {
        ops.push({ kind: "stroke", box, color: first.color, width: first.width, radius, alpha });
      }
      return;
    }
    for (const { side, width: lineWidth, color } of sides) {
      if (lineWidth <= 0 || isTransparent(color)) continue;
      const edge: Box =
        side === "Top"
          ? { ...box, height: lineWidth }
          : side === "Bottom"
            ? { ...box, y: box.y + box.height - lineWidth, height: lineWidth }
            : side === "Left"
              ? { ...box, width: lineWidth }
              : { ...box, x: box.x + box.width - lineWidth, width: lineWidth };
      ops.push({ kind: "fill", box: edge, color, radius: 0, alpha });
    }
  };

  const pushText = (text: string, rect: DOMRect, scope: Scope) => {
    const { style } = scope;
    const font = canvasFont(style);
    contentOps.push({
      kind: "text",
      text: transformText(text, style.textTransform),
      x: rect.left - originX,
      y: baselineIn(rect, font),
      font,
      color: style.color,
      direction: style.direction === "rtl" ? "rtl" : "ltr",
      letterSpacing: style.letterSpacing === "normal" ? "0px" : style.letterSpacing,
      alpha: scope.alpha,
    });
  };

  /** A word broken across lines is drawn one line at a time. */
  const pushBrokenWord = (node: Text, offset: number, word: string, scope: Scope) => {
    graphemes ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
    let run = "";
    let runRect: DOMRect | null = null;
    for (const { segment, index } of graphemes.segment(word)) {
      range.setStart(node, offset + index);
      range.setEnd(node, offset + index + segment.length);
      const rect = range.getBoundingClientRect();
      if (runRect && Math.abs(rect.top - runRect.top) < 1) {
        run += segment;
        continue;
      }
      if (runRect && run) pushText(run, runRect, scope);
      run = segment;
      runRect = rect;
    }
    if (runRect && run) pushText(run, runRect, scope);
  };

  /** Draws the longest prefix that fits before the ellipsis, as `text-overflow` does. */
  const pushTruncated = (node: Text, start: number, end: number, scope: Scope, right: number) => {
    context.font = canvasFont(scope.style);
    const limit = right - context.measureText(ELLIPSIS).width;
    range.setStart(node, start);
    let low = start;
    let high = end;
    let fitRight = 0;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      range.setEnd(node, middle);
      const rect = range.getBoundingClientRect();
      if (rect.right <= limit) {
        low = middle;
        fitRight = rect.right;
      } else {
        high = middle - 1;
      }
    }
    // Never end on half of a surrogate pair.
    if (low > start && /[\uD800-\uDBFF]/.test(node.data[low - 1] ?? "")) low -= 1;
    range.setEnd(node, Math.max(low, start + 1));
    const lineRect = range.getBoundingClientRect();
    const text = node.data.slice(start, low).trimEnd();
    if (text) pushText(text, lineRect, scope);
    else fitRight = lineRect.left;
    const markRect = new view.DOMRect(fitRight, lineRect.top, 0, lineRect.height);
    pushText(ELLIPSIS, markRect, scope);
  };

  const pushDecorations = (rects: DOMRectList, scope: Scope) => {
    if (!scope.decorations.length) return;
    const font = canvasFont(scope.style);
    const fontSize = Number.parseFloat(scope.style.fontSize) || 16;
    const { ascent } = metricsFor(font);
    for (const decoration of scope.decorations) {
      const thickness = Math.max(
        1,
        Number.parseFloat(decoration.textDecorationThickness) || fontSize / 16,
      );
      const lines = decoration.textDecorationLine.split(" ");
      for (const rect of rects) {
        const baseline = baselineIn(rect, font);
        for (const line of lines) {
          const y =
            line === "underline"
              ? baseline + fontSize * 0.1
              : line === "line-through"
                ? baseline - fontSize * 0.28
                : line === "overline"
                  ? baseline - ascent
                  : null;
          if (y === null) continue;
          contentOps.push({
            kind: "fill",
            box: {
              x: rect.left - originX,
              y: y - thickness / 2,
              width: rect.width,
              height: thickness,
            },
            color: decoration.textDecorationColor,
            radius: 0,
            alpha: scope.alpha,
          });
        }
      }
    }
  };

  const visitText = (node: Text, scope: Scope) => {
    const { style } = scope;
    if (style.visibility !== "visible") return;
    const data = node.data;
    const start = data.search(/\S/);
    if (start < 0) return;
    const end = data.trimEnd().length;
    range.setStart(node, start);
    range.setEnd(node, end);
    const rects = range.getClientRects();
    const [firstRect] = rects;
    if (!firstRect) return;
    const { ellipsis } = scope;
    if (ellipsis?.done) return;

    const slice = data.slice(start, end);
    const text = PRESERVED_SPACES.test(style.whiteSpace)
      ? slice
      : slice.replace(/[ \t\n\r\f]+/g, " ");
    // Chromium adds a rect for the part an ellipsis leaves visible, so a cut line has two.
    if (
      ellipsis &&
      style.direction !== "rtl" &&
      [...rects].some((rect) => rect.right > ellipsis.right + 0.5) &&
      [...rects].every((rect) => Math.abs(rect.top - firstRect.top) < 1)
    ) {
      ellipsis.done = true;
      pushTruncated(node, start, end, scope, ellipsis.right);
    } else if (rects.length === 1 && !/[\t\n\r\f]/.test(text)) {
      pushText(text, firstRect, scope);
    } else {
      // Wrapped lines, bidi runs, and tabs: place each word where layout put it.
      for (const match of slice.matchAll(/\S+/g)) {
        const wordStart = start + match.index;
        range.setStart(node, wordStart);
        range.setEnd(node, wordStart + match[0].length);
        const wordRects = range.getClientRects();
        const [wordRect] = wordRects;
        if (!wordRect) continue;
        if (wordRects.length === 1) pushText(match[0], wordRect, scope);
        else pushBrokenWord(node, wordStart, match[0], scope);
      }
    }
    pushDecorations(rects, scope);
  };

  const visitSvg = (svg: SVGSVGElement, style: CSSStyleDeclaration, alpha: number) => {
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const clone = svg.cloneNode(true);
    if (!(clone instanceof view.SVGSVGElement)) return;
    // Sprite icons point at a shared <symbol> elsewhere in the document; carry it along.
    const defs = document.createElementNS(svg.namespaceURI, "defs");
    const copied = new Set<string>();
    const pending = [...clone.querySelectorAll("use")];
    for (let use = pending.pop(); use; use = pending.pop()) {
      const href = use.getAttribute("href") ?? use.getAttributeNS(XLINK_NAMESPACE, "href");
      const id = href?.startsWith("#") ? href.slice(1) : null;
      if (!id || copied.has(id) || svg.querySelector(`#${CSS.escape(id)}`)) continue;
      const target = document.getElementById(id);
      if (!target) continue;
      copied.add(id);
      const copy = target.cloneNode(true);
      if (!(copy instanceof view.Element)) continue;
      defs.append(copy);
      pending.push(...copy.querySelectorAll("use"));
    }
    if (copied.size) clone.prepend(defs);
    if (!clone.hasAttribute("viewBox")) {
      clone.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);
    }
    // Rasterize at the output scale so icons stay sharp.
    clone.setAttribute("width", String(rect.width * scale));
    clone.setAttribute("height", String(rect.height * scale));
    clone.style.color = style.color;
    const url = URL.createObjectURL(
      new Blob([new view.XMLSerializer().serializeToString(clone)], { type: "image/svg+xml" }),
    );
    objectUrls.push(url);
    const image = new view.Image();
    image.src = url;
    contentOps.push({
      kind: "image",
      box: toBox(rect),
      image: image.decode().then(
        () => image,
        () => null,
      ),
      alpha,
    });
  };

  const visitImage = (image: HTMLImageElement, style: CSSStyleDeclaration, alpha: number) => {
    if (!image.complete || image.naturalWidth === 0 || !globalThis.createImageBitmap) return;
    const inset = (side: "Top" | "Right" | "Bottom" | "Left") =>
      (Number.parseFloat(style[`border${side}Width`]) || 0) +
      (Number.parseFloat(style[`padding${side}`]) || 0);
    const box = toBox(image.getBoundingClientRect());
    const width = box.width - inset("Left") - inset("Right");
    const height = box.height - inset("Top") - inset("Bottom");
    if (width <= 0 || height <= 0) return;
    // Capture the current source. If it would taint the PNG, omit that image.
    const captured = createImageBitmap(image, {
      resizeWidth: Math.max(1, Math.ceil(width * scale)),
      resizeHeight: Math.max(1, Math.ceil(height * scale)),
    }).then((bitmap) => {
      const probe = document.createElement("canvas");
      probe.width = probe.height = 1;
      const probeContext = probe.getContext("2d");
      try {
        if (!probeContext) throw new Error("A canvas is unavailable for the image.");
        probeContext.drawImage(bitmap, 0, 0, 1, 1);
        probeContext.getImageData(0, 0, 1, 1);
        return bitmap;
      } catch {
        bitmap.close();
        return null;
      }
    }, () => null);
    contentOps.push({
      kind: "image",
      box: { x: box.x + inset("Left"), y: box.y + inset("Top"), width, height },
      image: captured,
      alpha,
    });
  };

  const overflowClip = (element: Element, style: CSSStyleDeclaration) => {
    const clipsX = style.overflowX !== "visible";
    const clipsY = style.overflowY !== "visible";
    if (!clipsX && !clipsY) return null;
    const box = toBox(element.getBoundingClientRect());
    const left = box.x + (Number.parseFloat(style.borderLeftWidth) || 0);
    const top = box.y + (Number.parseFloat(style.borderTopWidth) || 0);
    const right = box.x + box.width - (Number.parseFloat(style.borderRightWidth) || 0);
    const bottom = box.y + box.height - (Number.parseFloat(style.borderBottomWidth) || 0);
    return {
      box: {
        x: clipsX ? left : -UNBOUNDED,
        y: clipsY ? top : -UNBOUNDED,
        width: clipsX ? right - left : UNBOUNDED * 2,
        height: clipsY ? bottom - top : UNBOUNDED * 2,
      },
      ellipsisRight: clipsX && style.textOverflow === "ellipsis"
        ? right - (Number.parseFloat(style.paddingRight) || 0) + originX
        : null,
    };
  };

  const visitChildren = (element: Element, scope: Scope) => {
    for (const child of element.childNodes) {
      if (child instanceof view.Element) visitElement(child, scope);
      else if (child instanceof view.Text) visitText(child, scope);
    }
  };

  const visitGraphic = (element: SVGElement | HTMLImageElement, style: CSSStyleDeclaration, alpha: number) => {
    if (style.visibility !== "visible") return;
    if (element instanceof view.SVGSVGElement) visitSvg(element, style, alpha);
    else if (element instanceof view.HTMLImageElement) visitImage(element, style, alpha);
  };

  const visitElement = (element: Element, parent: Scope | null) => {
    const style = view.getComputedStyle(element);
    if (isHidden(style)) return;
    const alpha = (parent?.alpha ?? 1) * (Number.parseFloat(style.opacity) || 0);
    if (alpha <= 0) return;
    if (element instanceof view.SVGElement || element instanceof view.HTMLImageElement) {
      visitGraphic(element, style, alpha);
      return;
    }

    const inline = (parent?.inline ?? false) || style.display.startsWith("inline");
    if (style.visibility === "visible") {
      for (const rect of element.getClientRects()) {
        paintBox(rect, style, alpha, inline ? contentOps : blockOps);
      }
    }

    const clip = overflowClip(element, style);
    if (clip) {
      // Both passes: a clipped block's descendants can be block boxes too.
      blockOps.push({ kind: "clip", box: clip.box });
      contentOps.push({ kind: "clip", box: clip.box });
    }
    visitChildren(element, {
      style,
      alpha,
      inline,
      decorations: textDecorations(style, parent),
      ellipsis: inheritedEllipsis(clip?.ellipsisRight, parent),
    });
    if (clip) {
      blockOps.push({ kind: "unclip" });
      contentOps.push({ kind: "unclip" });
    }
  };

  // The backdrop: the nearest opaque background behind the table and every layer above it.
  const backdrops: string[] = [];
  for (let element = table.parentElement; element; element = element.parentElement) {
    const color = view.getComputedStyle(element).backgroundColor;
    if (isTransparent(color)) continue;
    backdrops.push(color);
    if (isOpaque(color)) break;
  }

  try {
    visitElement(table, null);
    const images = await Promise.all(
      contentOps.map((op) => (op.kind === "image" ? op.image : null)),
    );

    // In device pixels: the canvas rounds its size, and a scaled fill could leave its last row half covered.
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    for (const color of backdrops.toReversed()) {
      context.fillStyle = color;
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    context.scale(scale, scale);
    paintOps(context, scale, blockOps, []);
    paintOps(context, scale, contentOps, images);

    const blob = "convertToBlob" in canvas
      ? await canvas.convertToBlob({ type: "image/png" })
      : await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("The table image could not be encoded.");
    return blob;
  } finally {
    for (const op of contentOps) {
      if (op.kind === "image") {
        void op.image.then((image) => {
          if (globalThis.ImageBitmap && image instanceof ImageBitmap) image.close();
        });
      }
    }
    for (const url of objectUrls) URL.revokeObjectURL(url);
  }
}

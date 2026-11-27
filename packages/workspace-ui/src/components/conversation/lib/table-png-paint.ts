// Adapted from T3 Code. See table-png.ts for the license.

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type DrawOp =
  | { kind: "fill"; box: Box; color: string; radius: number; alpha: number }
  | { kind: "stroke"; box: Box; color: string; width: number; radius: number; alpha: number }
  | {
      kind: "text";
      text: string;
      x: number;
      y: number;
      font: string;
      color: string;
      direction: CanvasDirection;
      letterSpacing: string;
      alpha: number;
    }
  | { kind: "image"; box: Box; image: Promise<CanvasImageSource | null>; alpha: number }
  | { kind: "clip"; box: Box }
  | { kind: "unclip" };

/** Replays draw ops; `images[i]` is the decoded source for an image op at index `i`. */
export function paintOps(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  scale: number,
  ops: readonly DrawOp[],
  images: readonly (CanvasImageSource | null)[],
): void {
  context.textBaseline = "alphabetic";
  context.textAlign = "left";
  // Snaps hard edges to device pixels so 1px rules stay crisp at any scale.
  const snap = (value: number) => Math.round(value * scale) / scale;
  let font = "";
  for (const [index, op] of ops.entries()) {
    switch (op.kind) {
      case "fill": {
        context.globalAlpha = op.alpha;
        context.fillStyle = op.color;
        if (op.radius > 0) {
          context.beginPath();
          context.roundRect(op.box.x, op.box.y, op.box.width, op.box.height, op.radius);
          context.fill();
        } else {
          const x = snap(op.box.x);
          const y = snap(op.box.y);
          context.fillRect(
            x,
            y,
            Math.max(snap(op.box.x + op.box.width) - x, 1 / scale),
            Math.max(snap(op.box.y + op.box.height) - y, 1 / scale),
          );
        }
        break;
      }
      case "stroke": {
        const inset = op.width / 2;
        context.globalAlpha = op.alpha;
        context.strokeStyle = op.color;
        context.lineWidth = op.width;
        context.beginPath();
        context.roundRect(
          op.box.x + inset,
          op.box.y + inset,
          op.box.width - op.width,
          op.box.height - op.width,
          Math.max(op.radius - inset, 0),
        );
        context.stroke();
        break;
      }
      case "text": {
        context.globalAlpha = op.alpha;
        // Parsing a font string is the costly part of a text draw; most runs share one.
        if (op.font !== font) {
          font = op.font;
          context.font = op.font;
        }
        context.fillStyle = op.color;
        context.direction = op.direction;
        context.letterSpacing = op.letterSpacing;
        context.fillText(op.text, op.x, op.y);
        break;
      }
      case "image": {
        const image = images[index];
        if (!image) break;
        context.globalAlpha = op.alpha;
        context.drawImage(image, op.box.x, op.box.y, op.box.width, op.box.height);
        break;
      }
      case "clip": {
        context.save();
        context.beginPath();
        context.rect(op.box.x, op.box.y, op.box.width, op.box.height);
        context.clip();
        break;
      }
      case "unclip": {
        context.restore();
        // A restore puts the saved font back too.
        font = "";
        break;
      }
    }
  }
}

// Adapted from T3 Code apps/mobile/src/features/browser/preview-stream-document.ts (MIT, see UPSTREAM.md).
import { z } from "zod";

export interface PreviewStreamConfiguration {
  /** False for the floating player: it shows the page and takes no input. */
  readonly interactive: boolean;
  readonly background: string;
}

/** The input a person gives a streamed page: coordinates in the page's own CSS viewport (`BrowserInteractOp`). */
const previewStreamInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("clickAt"), x: z.number(), y: z.number() }),
  z.object({ kind: z.literal("scrollAt"), x: z.number(), y: z.number(), deltaY: z.number() }),
  z.object({ kind: z.literal("insertText"), text: z.string() }),
  z.object({ kind: z.literal("press"), key: z.string() }),
]);
export type PreviewStreamInput = z.infer<typeof previewStreamInputSchema>;

const previewStreamMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("status"),
    status: z.enum(["connecting", "streaming", "error"]),
    detail: z.string().optional(),
  }),
  z.object({ type: z.literal("painted"), seq: z.number() }),
  z.object({ type: z.literal("input"), input: previewStreamInputSchema }),
  /** Ask whether the element under a touch takes text, so the keyboard can rise within the tap. */
  z.object({ type: z.literal("probe"), x: z.number(), y: z.number() }),
  /** The viewer's CSS size and pixel ratio, for the frame caps and "Fit to screen". */
  z.object({
    type: z.literal("size"),
    width: z.number(),
    height: z.number(),
    pixelRatio: z.number(),
  }),
  z.object({
    type: z.literal("pictureInPicture"),
    supported: z.boolean(),
    active: z.boolean(),
    detail: z.string().optional(),
  }),
]);
export type PreviewStreamMessage = z.infer<typeof previewStreamMessageSchema>;

export function previewStreamDocument(configuration: string, script: string) {
  const safeConfiguration = configuration.replace(/</g, "\\u003c");
  const safeScript = script.replace(/<\/script/gi, "<\\/script");
  const failure = `window.ReactNativeWebView.postMessage(JSON.stringify({type:"status",status:"error",detail:"Browser viewer stopped unexpectedly."}));`;
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>
  html, body { height: 100%; overflow: hidden; }
  body { margin: 0; }
  body > div { position: fixed; left: 0; top: 0; width: 100%; height: 100%; overflow: hidden; }
  canvas, video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
  canvas { touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
  video { pointer-events: none; }
  /* Pinned so focus never scrolls; 16px keeps iOS from zooming on focus. */
  textarea {
    position: fixed; left: 0; top: 0; width: 1px; height: 1px;
    padding: 0; margin: -1px; border: 0; overflow: hidden;
    clip: rect(0, 0, 0, 0); white-space: nowrap; font-size: 16px;
  }
</style></head><body><script>window.addEventListener("error",function(){${failure}});window.addEventListener("unhandledrejection",function(){${failure}});\n${safeScript}\ntry{SolusPreviewStream.start(${safeConfiguration});}catch(e){${failure}}</script></body></html>`;
}

export function previewStreamMessage(data: string): PreviewStreamMessage | null {
  try {
    const parsed = previewStreamMessageSchema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The expression a probe runs in the page: does the element at this point take
 * text? Coordinates are the page's CSS viewport, as `clickAt` uses.
 */
export function editableProbeExpression(x: number, y: number): string {
  return `(() => { const element = document.elementFromPoint(${Number(x)}, ${Number(y)}); if (!element) return false; const field = element.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]'); if (!field) return false; if (field instanceof HTMLInputElement) return !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(field.type) && !field.disabled && !field.readOnly; if (field instanceof HTMLTextAreaElement) return !field.disabled && !field.readOnly; return !(field instanceof HTMLSelectElement); })()`;
}

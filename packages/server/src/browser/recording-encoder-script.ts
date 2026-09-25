import { z } from 'zod'
import type { BrowserRecordingEncoder, BrowserRecordingSize } from './surface-driver'

/**
 * The recording encoder, as a script for a blank Chromium page.
 *
 * Both hosts run the same page: the standalone server in a Playwright Chromium,
 * the desktop in a hidden window. Only `evaluate` differs between them, so the
 * encoder is written once here and each host supplies how to run an expression.
 *
 * The page draws each JPEG frame on a canvas, and `MediaRecorder` records the
 * canvas stream. Chromium sends a screencast frame only when the guest paints,
 * so the canvas holds the last picture between paints and the recorder's own
 * clock keeps the timeline true.
 */

/** Recording caps the frame rate, not the frame count: a page that is idle
 *  paints nothing, and the canvas stream simply repeats the last picture. */
const FRAME_RATE = 25

/** H.264 MP4 is the shared recording format across clients. */
const MIME_TYPES = ['video/mp4;codecs=avc1', 'video/mp4']

/**
 * The bitrate the encoder aims for.
 *
 * t3code scales `width × height × fps × 0.05` between 2.5 and 50 Mbit/s. That
 * floor alone is 94 MB for five minutes, twice the 50 MB a recording may be.
 * 50 MiB over the five-minute limit is 1.40 Mbit/s, so the ceiling is 1.2 Mbit/s:
 * the rest is room for the container and for rate control overshooting. Screen
 * content is mostly still, so real recordings come out far smaller, and the
 * recorder's size limit is the backstop for the ones that do not.
 */
export const RECORDING_MAX_BITRATE = 1_200_000
const RECORDING_MIN_BITRATE = 500_000

export function recordingBitrate(size: BrowserRecordingSize): number {
  const scaled = size.width * size.height * FRAME_RATE * 0.05
  return Math.round(Math.min(RECORDING_MAX_BITRATE, Math.max(RECORDING_MIN_BITRATE, scaled)))
}

/** `evaluate` returns what the page produced, and a reply that is too large
 *  fails. The finished MP4 comes back in slices of this many bytes. */
const READ_CHUNK_BYTES = 4 * 1024 * 1024

/** One global on the blank page. Nothing else runs there. */
const GLOBAL = '__solusRecordingEncoder'

/** What the encoder page's methods return: the open result, a byte count, or
 *  a base64 slice. Parsed on arrival like any other page output. */
export type EncoderPageValue = { ok: boolean; mimeType?: string; message?: string } | number | string

/** Runs one expression in the encoder page and returns its value. */
export type EncoderEvaluate = (expression: string) => Promise<EncoderPageValue>

const openedSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), mimeType: z.string() }),
  z.object({ ok: z.literal(false), message: z.string() }),
])

/**
 * Start the encoder on a page that is already open, and return its handle.
 *
 * Throws when the page cannot record H.264: that Chromium has no H.264 encoder,
 * and every entry point must report that failure.
 * The caller still owns the page then; `close` is only the encoder's dispose.
 */
export async function openScriptEncoder(
  evaluate: EncoderEvaluate,
  size: BrowserRecordingSize,
  close: () => Promise<void>,
): Promise<BrowserRecordingEncoder> {
  const opened = openedSchema.safeParse(await evaluate(installExpression(size)))
  if (!opened.success || !opened.data.ok) {
    throw new Error(
      opened.success && !opened.data.ok
        ? opened.data.message
        : 'The recording encoder did not start.',
    )
  }
  let disposed = false
  return {
    async frame(jpeg) {
      const recordedBytes = z.number().safeParse(
        await evaluate(`window.${GLOBAL}.frame(${JSON.stringify(Buffer.from(jpeg).toString('base64'))})`),
      )
      return { recordedBytes: recordedBytes.success ? recordedBytes.data : 0 }
    },
    async finish() {
      const total = z.number().int().nonnegative().parse(await evaluate(`window.${GLOBAL}.finish()`))
      const bytes = new Uint8Array(total)
      for (let offset = 0; offset < total; offset += READ_CHUNK_BYTES) {
        const slice = z.string().parse(await evaluate(`window.${GLOBAL}.read(${offset}, ${READ_CHUNK_BYTES})`))
        bytes.set(Buffer.from(slice, 'base64'), offset)
      }
      return bytes
    },
    async dispose() {
      if (disposed) return
      disposed = true
      await close()
    },
  }
}

/**
 * The page side. Each method is called by `evaluate` and returns a plain value.
 *
 * Frames are drawn to fit the canvas and centred, so a viewport that changes
 * shape during a recording is letterboxed instead of stretched.
 */
function installExpression(size: BrowserRecordingSize): string {
  return `(() => {
  const W = ${size.width};
  const H = ${size.height};
  const MIME_TYPES = ${JSON.stringify(MIME_TYPES)};
  if (typeof MediaRecorder === 'undefined') {
    return { ok: false, message: 'This Chromium cannot record: MediaRecorder is missing.' };
  }
  const mimeType = MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
  if (!mimeType) {
    return { ok: false, message: 'This Chromium cannot record H.264 MP4.' };
  }
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  document.body.appendChild(canvas);
  const context = canvas.getContext('2d');
  context.fillStyle = '#000';
  context.fillRect(0, 0, W, H);
  const stream = canvas.captureStream(${FRAME_RATE});
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: ${recordingBitrate(size)} });
  const chunks = [];
  let recordedBytes = 0;
  let result = null;
  recorder.ondataavailable = (event) => {
    if (!event.data || event.data.size === 0) return;
    chunks.push(event.data);
    recordedBytes += event.data.size;
  };
  const decode = (base64) => {
    if (Uint8Array.fromBase64) return Uint8Array.fromBase64(base64);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  };
  const encode = (bytes) => {
    if (bytes.toBase64) return bytes.toBase64();
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  };
  window[${JSON.stringify(GLOBAL)}] = {
    async frame(base64) {
      const image = await createImageBitmap(new Blob([decode(base64)], { type: 'image/jpeg' }));
      const scale = Math.min(W / image.width, H / image.height);
      const width = Math.round(image.width * scale);
      const height = Math.round(image.height * scale);
      if (width < W || height < H) context.fillRect(0, 0, W, H);
      context.drawImage(image, Math.round((W - width) / 2), Math.round((H - height) / 2), width, height);
      image.close();
      return recordedBytes;
    },
    finish() {
      if (result) return Promise.resolve(result.size);
      return new Promise((resolve, reject) => {
        recorder.onerror = (event) => reject(new Error(String(event.error || 'The recorder failed.')));
        recorder.onstop = () => {
          for (const track of stream.getTracks()) track.stop();
          result = new Blob(chunks, { type: mimeType });
          chunks.length = 0;
          resolve(result.size);
        };
        recorder.stop();
      });
    },
    async read(offset, length) {
      return encode(new Uint8Array(await result.slice(offset, offset + length).arrayBuffer()));
    },
  };
  recorder.start(1000);
  return { ok: true, mimeType };
})()`
}

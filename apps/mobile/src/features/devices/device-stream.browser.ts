// Adapted from T3 Code apps/mobile/src/features/devices/device-stream.browser.ts (MIT, see UPSTREAM.md).
// Runs inside the viewer WebView. Keep it free of renderer stores and native APIs: only the message bridge crosses it.
import { DeviceHubStream } from "@solus/client-core/device-hub-stream";
import { DeviceVideoDecoder, browserVideoCodecs, framePlacement } from "@solus/client-core/device-video";
import type { DeviceButton, DeviceInput, DeviceScreenConfig } from "@solus/contracts/device-types";

import { DeviceInputGate } from "./device-input-gate";
import type { DeviceStreamConfiguration, DeviceStreamMessage } from "./device-stream-document";

declare global {
  interface Window {
    ReactNativeWebView: { postMessage: (message: string) => void };
  }
}

interface Viewer {
  readonly stop: () => void;
  readonly send: (input: DeviceInput) => void;
  readonly enable: (value: boolean) => void;
  readonly refuse: () => void;
}

let activeViewer: Viewer | null = null;
let mayInteract = false;
let requestId = 0;
const urls = new Map<number, { resolve: (url: string) => void; reject: (error: Error) => void }>();

const post = (message: DeviceStreamMessage) =>
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- The native WebView bridge takes one string.
  window.ReactNativeWebView.postMessage(JSON.stringify(message));

export function stop() {
  activeViewer?.stop();
  activeViewer = null;
}

/** The app answers a URL request with a fresh stream URL, or null when the host refused. */
export function url(id: number, value: string | null) {
  const pending = urls.get(id);
  urls.delete(id);
  if (value) pending?.resolve(value);
  else pending?.reject(new Error("Cannot open the device stream."));
}

/** Input goes to the device only while this viewer holds its control lease. */
export function enabled(value: boolean) {
  mayInteract = value;
  activeViewer?.enable(value);
}

export function controlRefused() { activeViewer?.refuse(); }

export function command(button: DeviceButton | "rotate") {
  activeViewer?.send(button === "rotate" ? { kind: "rotate" } : { kind: "button", button });
}

export function text(value: string) {
  if (value) activeViewer?.send({ kind: "text", text: value });
}

function openUrl(): Promise<string> {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    urls.set(id, { resolve, reject });
    post({ type: "url", requestId: id });
    setTimeout(() => {
      if (urls.delete(id)) reject(new Error("The host did not answer."));
    }, 15_000);
  });
}

export function start(configuration: DeviceStreamConfiguration) {
  stop();
  const { colors, platform, kind } = configuration;
  Object.assign(document.documentElement.style, { height: "100%", overflow: "hidden" });
  Object.assign(document.body.style, {
    margin: "0",
    height: "100%",
    overflow: "hidden",
    background: colors.background,
    color: colors.muted,
    fontFamily: "system-ui",
  });
  const container = document.createElement("div");
  Object.assign(container.style, {
    position: "fixed",
    inset: "0",
    containerType: "size",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  });
  const frame = document.createElement("div");
  frame.setAttribute("role", "application");
  frame.setAttribute("aria-label", platform === "ios" ? "iOS Simulator screen" : "Android Emulator screen");
  frame.tabIndex = 0;
  Object.assign(frame.style, {
    position: "relative",
    touchAction: "none",
    userSelect: "none",
    webkitUserSelect: "none",
    webkitTouchCallout: "none",
    outline: "none",
  });
  const canvas = document.createElement("canvas");
  Object.assign(canvas.style, { position: "absolute", inset: "0", width: "100%", height: "100%", pointerEvents: "none" });
  frame.append(canvas);
  container.append(frame);
  document.body.replaceChildren(container);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This WebView cannot draw the device screen.");

  // The frame takes the screen's aspect, so a touch maps onto the screen and nothing else.
  let aspect = 0;
  const layout = (next: number) => {
    if (Math.abs(next - aspect) < 0.001) return;
    aspect = next;
    frame.style.width = `min(100cqw, ${aspect * 100}cqh)`;
    frame.style.height = `min(100cqh, ${100 / aspect}cqw)`;
  };
  layout(9 / 19.5);

  let stopped = false;
  let streaming = false;
  const reportStatus = (status: "connecting" | "streaming" | "error", detail?: string) => {
    if (stopped) return;
    streaming = status === "streaming";
    const message: DeviceStreamMessage = detail ? { type: "status", status, detail } : { type: "status", status };
    post(message);
  };
  let screen: DeviceScreenConfig | null = null;
  const paint = (source: CanvasImageSource, width: number, height: number) => {
    const placement = framePlacement(screen, width, height);
    if (canvas.width !== placement.width || canvas.height !== placement.height) {
      canvas.width = placement.width;
      canvas.height = placement.height;
      layout(placement.width / placement.height);
    }
    context.setTransform(...placement.transform);
    context.drawImage(source, 0, 0, width, height);
    context.resetTransform();
    if (!streaming) reportStatus("streaming");
  };
  const codecs = browserVideoCodecs();
  let format: "h264" | "jpeg" = codecs || platform === "android" || kind === "simlock" ? "h264" : "jpeg";
  let hub: DeviceHubStream | null = null;
  let generation = 0;
  let previousGeneration: number | null = null;
  let firstVideoTimer: ReturnType<typeof setTimeout> | null = null;
  const clearFirstVideoTimer = () => {
    if (firstVideoTimer !== null) clearTimeout(firstVideoTimer);
    firstVideoTimer = null;
  };
  const decoder = new DeviceVideoDecoder(
    {
      present: (source, width, height, kind) => {
        if (kind === "video") clearFirstVideoTimer();
        // SAFETY: the decoder presents only VideoFrames or ImageBitmaps, both canvas sources.
        paint(source as CanvasImageSource, width, height);
      },
      screen: (value) => {
        screen = value;
      },
      needsKeyframe: () => hub?.requestKeyframe(),
      status: (status) => {
        // An iOS Simulator also streams JPEG, for a WebView that cannot decode H.264.
        if (status.kind === "unsupported" && platform === "ios" && kind !== "simlock" && format === "h264") {
          format = "jpeg";
          startStream();
          return;
        }
        if (status.kind === "streaming") return;
        if (status.kind === "ended") reportStatus("error", status.detail);
        else if (status.kind === "unsupported") reportStatus("error", "This device cannot decode the video.");
        else if (streaming) reportStatus("connecting");
      },
    },
    codecs,
    (blob) => createImageBitmap(blob),
  );
  function startStream() {
    clearFirstVideoTimer();
    hub?.close();
    // A seed is not proof that H.264 is decoding. Real phones can expose
    // WebCodecs but never deliver a frame; use JPEG instead of freezing on it.
    if (format === "h264" && platform === "ios" && kind !== "simlock") {
      firstVideoTimer = setTimeout(() => {
        if (stopped) return;
        format = "jpeg";
        reportStatus("connecting");
        startStream();
      }, 8_000);
    }
    previousGeneration = null;
    hub = new DeviceHubStream({ platform, format, serveSimOnly: kind === "simlock", openUrl,
      onPacket: (packet, data) => {
        if (previousGeneration !== packet.streamGeneration) {
          previousGeneration = packet.streamGeneration;
          generation++;
        }
        decoder.push({ ...packet, streamGeneration: generation }, data);
      },
    });
    hub.start();
  }
  // Input and video share screen configuration and one stream generation.
  startStream();

  const gate = new DeviceInputGate(
    (input) => { void hub?.send([input]).catch(() => reportStatus("error", "Device input disconnected. Reconnect to try again.")); },
    () => post({ type: "control" }),
  );
  gate.setEnabled(mayInteract);
  const send = (input: DeviceInput) => gate.push(input);
  let pointerId: number | null = null;
  const touch = (event: PointerEvent, phase: "down" | "move" | "up" | "cancel") => {
    const rect = frame.getBoundingClientRect();
    send({
      kind: "pointer",
      phase,
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    });
  };
  frame.addEventListener("pointerdown", (event) => {
    if (pointerId !== null) return;
    event.preventDefault();
    pointerId = event.pointerId;
    frame.setPointerCapture(event.pointerId);
    frame.focus();
    touch(event, "down");
  });
  frame.addEventListener("pointermove", (event) => {
    if (pointerId === event.pointerId) touch(event, "move");
  });
  const endTouch = (event: PointerEvent) => {
    if (pointerId !== event.pointerId) return;
    pointerId = null;
    touch(event, event.type === "pointercancel" ? "cancel" : "up");
  };
  frame.addEventListener("pointerup", endTouch);
  frame.addEventListener("pointercancel", endTouch);
  frame.addEventListener("lostpointercapture", endTouch);
  // A hardware keyboard types on the device while the frame has focus.
  const key = (event: KeyboardEvent, phase: "down" | "up") => {
    event.preventDefault();
    send({ kind: "key", phase, code: event.code, key: event.key, hasModifier: event.metaKey || event.ctrlKey || event.altKey });
  };
  frame.addEventListener("keydown", (event) => key(event, "down"));
  frame.addEventListener("keyup", (event) => key(event, "up"));

  activeViewer = {
    stop: () => {
      stopped = true;
      clearFirstVideoTimer();
      hub?.close();
      gate.refused();
      decoder.close();
    },
    send,
    enable: (value) => gate.setEnabled(value),
    refuse: () => gate.refused(),
  };
  window.addEventListener("pagehide", stop, { once: true });
  reportStatus("connecting");
}

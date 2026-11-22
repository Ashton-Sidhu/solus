// Adapted from T3 Code apps/mobile/src/features/browser/preview-stream.browser.ts (MIT, see UPSTREAM.md).
// Runs inside the viewer WebView. Frames come in from the app as base64 JPEG;
// input goes out as Solus's streamed-surface ops (clickAt, scrollAt,
// insertText, press), which the app sends to the host.
import type {
  PreviewStreamConfiguration,
  PreviewStreamInput,
  PreviewStreamMessage,
} from "./preview-stream-document";

declare global {
  interface Window {
    ReactNativeWebView: { postMessage: (message: string) => void };
  }
}

interface PresentationVideo extends HTMLVideoElement {
  webkitSetPresentationMode?: (mode: "inline" | "picture-in-picture") => void;
  webkitPresentationMode?: string;
}

const RESIZE_DEBOUNCE_MS = 150;
const TAP_SLOP_PX = 8;
const WHEEL_LINE_PX = 16;
const MAX_PIXEL_RATIO = 2;
// Reuse nearby probe answers: slow replies arrive too late after touch-end to raise the iOS keyboard.
const PROBE_REUSE_PX = 24;
const PROBE_REUSE_MS = 10_000;
// A sentinel makes backspace fire input; Gboard keydown supplies only keyCode 229.
const SENTINEL = "​";
/** Keys a streamed page takes as a press; printable text arrives through `input`. */
const NAMED_KEYS = new Set([
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

interface Viewer {
  readonly stop: () => void;
  readonly frame: (seq: number, base64: string) => void;
  readonly viewport: (width: number, height: number) => void;
  readonly enabled: (value: boolean) => void;
  readonly probeResult: (x: number, y: number, editable: boolean) => void;
  readonly togglePictureInPicture: () => void;
}

let activeViewer: Viewer | null = null;

export function stop() {
  activeViewer?.stop();
  activeViewer = null;
}

export function frame(seq: number, base64: string) {
  activeViewer?.frame(seq, base64);
}

/** The page's CSS viewport, which input coordinates are expressed in. */
export function viewport(width: number, height: number) {
  activeViewer?.viewport(width, height);
}

/** False while the page cannot be driven, such as while its DevTools are open. */
export function enabled(value: boolean) {
  activeViewer?.enabled(value);
}

export function probeResult(x: number, y: number, editable: boolean) {
  activeViewer?.probeResult(x, y, editable);
}

export function pictureInPicture() {
  activeViewer?.togglePictureInPicture();
}

export function start(configuration: PreviewStreamConfiguration) {
  stop();
  const post = (message: PreviewStreamMessage) => {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- The native WebView bridge takes one string.
    window.ReactNativeWebView.postMessage(JSON.stringify(message));
  };
  const { interactive } = configuration;
  document.body.style.background = configuration.background;
  const container = document.createElement("div");
  const canvas = document.createElement("canvas");
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Browser page");
  container.append(canvas);
  const input = document.createElement("textarea");
  input.setAttribute("aria-label", "Browser page input");
  input.autocapitalize = "off";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("autocorrect", "off");
  input.disabled = true;
  document.body.replaceChildren(container, ...(interactive ? [input] : []));
  const context = canvas.getContext("2d");

  let stopped = false;
  let streaming = false;
  let mayDrive = false;
  let pageViewport: { width: number; height: number } | null = null;
  let size: { width: number; height: number } | null = null;
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  let wheelFrame: number | null = null;
  let pendingWheel: Extract<PreviewStreamInput, { kind: "scrollAt" }> | null = null;
  let probe: {
    readonly x: number;
    readonly y: number;
    readonly clientX: number;
    readonly clientY: number;
    editable: boolean | null;
    end: "touching" | "acted" | "late" | "panned";
  } | null = null;
  let probeCache: {
    readonly clientX: number;
    readonly clientY: number;
    readonly editable: boolean;
    readonly time: number;
  } | null = null;
  let keySent = false;
  let touch: { start: PointerEvent; last: PointerEvent; panning: boolean } | null = null;

  const send = (message: PreviewStreamInput) => {
    if (mayDrive) post({ type: "input", input: message });
  };
  const clearInput = () => {
    if (wheelFrame !== null) cancelAnimationFrame(wheelFrame);
    wheelFrame = null;
    pendingWheel = null;
    probe = probeCache = touch = null;
    keySent = false;
    input.value = SENTINEL;
    input.disabled = true;
    input.blur();
  };

  const image = new Image();
  const paint = (seq: number, base64: string) => {
    if (stopped || !context) return;
    image.onload = () => {
      if (stopped) return;
      if (canvas.width !== image.naturalWidth || canvas.height !== image.naturalHeight) {
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
      }
      context.drawImage(image, 0, 0);
      post({ type: "painted", seq });
      if (!streaming) {
        streaming = true;
        post({ type: "status", status: "streaming" });
      }
      sendPictureInPictureFrame();
    };
    // A frame that cannot decode is dropped; the next one replaces it.
    image.onerror = () => post({ type: "painted", seq });
    image.src = `data:image/jpeg;base64,${base64}`;
  };

  // The layout viewport, which the keyboard does not shrink: "Fit to screen" must not take a keyboard-sized page.
  const measure = () => {
    resizeTimer = null;
    const next = { width: Math.round(window.innerWidth), height: Math.round(window.innerHeight) };
    if (next.width < 1 || next.height < 1) return;
    if (size?.width === next.width && size.height === next.height) return;
    size = next;
    post({
      type: "size",
      ...next,
      pixelRatio: Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO),
    });
  };
  const observer = new ResizeObserver(() => {
    if (resizeTimer !== null) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(measure, size === null ? 0 : RESIZE_DEBOUNCE_MS);
  });
  observer.observe(container);

  // iOS keeps its layout viewport under the keyboard; resize to the visual viewport.
  const visualViewport = window.visualViewport;
  const followVisualViewport = () => {
    if (!visualViewport) return;
    container.style.top = `${visualViewport.offsetTop}px`;
    container.style.height = `${visualViewport.height}px`;
  };
  if (interactive) {
    visualViewport?.addEventListener("resize", followVisualViewport);
    visualViewport?.addEventListener("scroll", followVisualViewport);
  }

  // The frame is letterboxed inside the canvas box; map a point back to the page's CSS viewport.
  const pagePoint = (clientX: number, clientY: number, clamp: boolean) => {
    if (!mayDrive || !pageViewport || canvas.width === 0 || canvas.height === 0) return null;
    const rect = canvas.getBoundingClientRect();
    const fit = Math.min(rect.width / canvas.width, rect.height / canvas.height);
    const width = canvas.width * fit;
    const height = canvas.height * fit;
    if (!(width > 0 && height > 0)) return null;
    const scale = pageViewport.width / width;
    const x = (clientX - rect.left - (rect.width - width) / 2) * scale;
    const y = (clientY - rect.top - (rect.height - height) / 2) * (pageViewport.height / height);
    const inside = x >= 0 && y >= 0 && x <= pageViewport.width && y <= pageViewport.height;
    if (!inside && !clamp) return null;
    return {
      x: Math.round(Math.min(Math.max(x, 0), pageViewport.width)),
      y: Math.round(Math.min(Math.max(y, 0), pageViewport.height)),
      scale,
    };
  };

  const flushWheel = () => {
    if (wheelFrame !== null) cancelAnimationFrame(wheelFrame);
    wheelFrame = null;
    const wheel = pendingWheel;
    pendingWheel = null;
    if (wheel && wheel.deltaY !== 0) send(wheel);
  };
  // Solus scrolls a streamed page vertically only; a frame's worth of deltas crosses as one op.
  const queueWheel = (point: { x: number; y: number }, deltaY: number) => {
    pendingWheel = {
      kind: "scrollAt",
      x: point.x,
      y: point.y,
      deltaY: Math.round((pendingWheel?.deltaY ?? 0) + deltaY),
    };
    wheelFrame ??= requestAnimationFrame(flushWheel);
  };

  const onPointerDown = (event: PointerEvent) => {
    if (!mayDrive || !event.isPrimary) return;
    event.preventDefault();
    touch = { start: event, last: event, panning: false };
    if (event.pointerType !== "touch") {
      canvas.setPointerCapture(event.pointerId);
      input.focus({ preventScroll: true });
      return;
    }
    const point = pagePoint(event.clientX, event.clientY, false);
    if (!point) {
      probe = null;
      return;
    }
    const cached = probeCache;
    const reuse =
      cached !== null &&
      performance.now() - cached.time < PROBE_REUSE_MS &&
      Math.hypot(event.clientX - cached.clientX, event.clientY - cached.clientY) <= PROBE_REUSE_PX;
    probe = {
      x: point.x,
      y: point.y,
      clientX: event.clientX,
      clientY: event.clientY,
      editable: reuse ? cached.editable : null,
      end: "touching",
    };
    post({ type: "probe", x: point.x, y: point.y });
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!mayDrive || !touch || touch.start.pointerId !== event.pointerId) return;
    if (
      !touch.panning &&
      Math.hypot(event.clientX - touch.start.clientX, event.clientY - touch.start.clientY) <
        TAP_SLOP_PX
    ) {
      return;
    }
    touch.panning = true;
    // A mouse drag is not a scroll; only a finger pans the page.
    if (event.pointerType === "touch") {
      const point = pagePoint(event.clientX, event.clientY, true);
      if (point) queueWheel(point, (touch.last.clientY - event.clientY) * point.scale);
    }
    touch.last = event;
  };
  const onPointerEnd = (event: PointerEvent) => {
    const cancelled = event.type === "pointercancel";
    const ended = touch;
    if (!ended || ended.start.pointerId !== event.pointerId) return;
    touch = null;
    const answered = probe;
    if (cancelled || ended.panning) {
      if (answered) answered.end = "panned";
      flushWheel();
      return;
    }
    const point = pagePoint(event.clientX, event.clientY, false);
    if (!point) return;
    if (event.pointerType === "touch") {
      // Focusing inside the tap's user activation is what lets iOS raise the keyboard.
      if (answered?.editable === true) input.focus({ preventScroll: true });
      else if (answered?.editable === false) input.blur();
      if (answered) answered.end = answered.editable === null ? "late" : "acted";
    }
    flushWheel();
    send({ kind: "clickAt", x: point.x, y: point.y });
  };
  const onWheel = (event: WheelEvent) => {
    const point = pagePoint(event.clientX, event.clientY, false);
    if (!point) return;
    event.preventDefault();
    const unit =
      event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? WHEEL_LINE_PX
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? (pageViewport?.height ?? 0)
          : 1;
    queueWheel(point, event.deltaY * unit);
  };
  const preventDefault = (event: Event) => event.preventDefault();

  const onKeyDown = (event: KeyboardEvent) => {
    if (!mayDrive) return;
    if (
      event.isComposing ||
      event.keyCode === 229 ||
      event.key === "Process" ||
      event.key === "Unidentified"
    )
      return;
    // The app's own chords, and paste (which the app reads from the clipboard), stay with the app.
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (!NAMED_KEYS.has(event.key)) return;
    send({ kind: "press", key: event.key });
    // Some Android keyboards edit the textarea even when keydown is prevented.
    keySent = event.key === "Backspace" || event.key === "Delete";
    event.preventDefault();
  };
  const resetInput = () => {
    input.value = SENTINEL;
    // iOS WebKit focuses a field whose selection is set, which would raise the keyboard unasked.
    if (document.activeElement === input) input.setSelectionRange(SENTINEL.length, SENTINEL.length);
  };
  const onInput = (event: Event) => {
    if (event instanceof InputEvent && event.isComposing) return;
    const inputType = event instanceof InputEvent ? event.inputType : "";
    if (keySent) keySent = false;
    else if (inputType === "deleteContentBackward") send({ kind: "press", key: "Backspace" });
    else if (inputType === "deleteContentForward") send({ kind: "press", key: "Delete" });
    else if (inputType === "insertLineBreak") send({ kind: "press", key: "Enter" });
    else {
      const value = input.value;
      const text = value.startsWith(SENTINEL) ? value.slice(SENTINEL.length) : value;
      if (text) send({ kind: "insertText", text });
    }
    resetInput();
  };
  const onCompositionEnd = (event: CompositionEvent) => {
    const text = event.data.startsWith(SENTINEL) ? event.data.slice(SENTINEL.length) : event.data;
    if (text) send({ kind: "insertText", text });
    resetInput();
  };

  if (interactive) {
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerEnd);
    canvas.addEventListener("pointercancel", onPointerEnd);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("mousedown", preventDefault);
    canvas.addEventListener("contextmenu", preventDefault);
    input.addEventListener("keydown", onKeyDown);
    input.addEventListener("input", onInput);
    input.addEventListener("compositionend", onCompositionEnd);
    input.addEventListener("focus", resetInput);
    // Copying the input would put its sentinel on this device's clipboard.
    input.addEventListener("copy", preventDefault);
    input.addEventListener("cut", preventDefault);
    resetInput();
  }

  // WebKit reports no support on a video that has not loaded yet; check the prototype.
  const videoPrototype: PresentationVideo = HTMLVideoElement.prototype;
  const pictureInPictureSupported =
    interactive &&
    "captureStream" in canvas &&
    "CanvasCaptureMediaStreamTrack" in window &&
    ((document.pictureInPictureEnabled === true && "requestPictureInPicture" in videoPrototype) ||
      "webkitSetPresentationMode" in videoPrototype);
  // WebKit revokes activation after return; start picture in picture before awaiting. Prepare paused video before the tap.
  let video: PresentationVideo | null = null;
  let track: CanvasCaptureMediaStreamTrack | null = null;
  const pictureInPictureActive = () =>
    video !== null &&
    (document.pictureInPictureElement === video ||
      video.webkitPresentationMode === "picture-in-picture");
  const reportPictureInPicture = (detail?: string) => {
    const message: PreviewStreamMessage = {
      type: "pictureInPicture",
      supported: pictureInPictureSupported,
      active: pictureInPictureActive(),
    };
    if (detail) message.detail = detail;
    post(message);
  };
  // Called after each paint. A frame drawn before the player attached is lost, so retry.
  const sendPictureInPictureFrame = () => {
    if (video && (video.readyState === HTMLMediaElement.HAVE_NOTHING || pictureInPictureActive())) {
      track?.requestFrame();
    }
  };
  if (pictureInPictureSupported) {
    const stream = canvas.captureStream(0);
    const [captured] = stream.getVideoTracks();
    const element: PresentationVideo = document.createElement("video");
    element.muted = true;
    element.playsInline = true;
    // Under the canvas at full size: WebKit pauses muted video it considers off screen.
    element.srcObject = stream;
    for (const name of [
      "enterpictureinpicture",
      "leavepictureinpicture",
      "webkitpresentationmodechanged",
    ]) {
      element.addEventListener(name, () => {
        if (!pictureInPictureActive()) element.pause();
        reportPictureInPicture();
      });
    }
    container.prepend(element);
    canvas.style.background = configuration.background;
    video = element;
    track = captured instanceof CanvasCaptureMediaStreamTrack ? captured : null;
  }
  const togglePictureInPicture = () => {
    const element = video;
    if (!element) return;
    if (pictureInPictureActive()) {
      if (document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => {});
      else element.webkitSetPresentationMode?.("inline");
      return;
    }
    if (element.readyState === HTMLMediaElement.HAVE_NOTHING) {
      reportPictureInPicture("The page has not shown yet. Try again in a moment.");
      return;
    }
    // The page may have changed since the video's last frame. WebKit captures only on a draw.
    track?.requestFrame();
    canvas.getContext("2d")?.drawImage(canvas, 0, 0);
    const fail = (error: Error) => {
      element.pause();
      reportPictureInPicture(error.message || "Picture in picture is unavailable.");
    };
    if (document.pictureInPictureEnabled) {
      const entering = element.requestPictureInPicture();
      void Promise.all([entering, element.play()]).catch(fail);
    } else {
      element.webkitSetPresentationMode?.("picture-in-picture");
      void element.play().catch(fail);
    }
  };

  activeViewer = {
    stop: () => {
      stopped = true;
      observer.disconnect();
      visualViewport?.removeEventListener("resize", followVisualViewport);
      visualViewport?.removeEventListener("scroll", followVisualViewport);
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      if (wheelFrame !== null) cancelAnimationFrame(wheelFrame);
      track?.stop();
      if (video) video.srcObject = null;
    },
    frame: paint,
    viewport: (width, height) => {
      pageViewport = { width, height };
    },
    enabled: (value) => {
      if (value === mayDrive) return;
      mayDrive = value && interactive;
      if (mayDrive) input.disabled = false;
      else clearInput();
    },
    probeResult: (x, y, editable) => {
      const current = probe;
      if (!mayDrive || !current || current.x !== x || current.y !== y) return;
      probeCache = {
        clientX: current.clientX,
        clientY: current.clientY,
        editable,
        time: performance.now(),
      };
      if (current.end === "touching") {
        current.editable = editable;
        return;
      }
      probe = null;
      if (current.end === "panned") return;
      if (current.end === "acted" && current.editable === editable) return;
      // Late answers can raise Android's keyboard; iOS needs another tap.
      if (editable) input.focus({ preventScroll: true });
      else input.blur();
    },
    togglePictureInPicture,
  };
  window.addEventListener("pagehide", stop, { once: true });
  post({ type: "status", status: "connecting" });
  if (interactive) reportPictureInPicture();
}

<script lang="ts">
  import type { DevicePlatform, DeviceInput } from "@solus/contracts/device-types";
  import { devicesStore, deviceErrorMessage } from "../../contexts/devices/devices.store.svelte";
  import { DeviceVideoDecoder, browserVideoCodecs, type DeviceVideoStatus } from "./lib/device-video";
  import { DeviceInputBatcher, clampedPoint, containedRect, keyInput, normalizedPoint, scrollDelta } from "./lib/device-input";

  /**
   * One device's live screen. It subscribes to video only while `active`, so a
   * hidden pane decodes nothing and the host sends nothing. Pointer, wheel and
   * key input go to the device through this client's control lease; the
   * text field forwards a touch keyboard's typing.
   */

  interface Props {
    serverId: string;
    deviceHostId: string;
    deviceId: string;
    platform: DevicePlatform;
    active: boolean;
    /** Input is refused while someone else controls the device. */
    canInteract: boolean;
    onInputError: (message: string) => void;
  }

  let { serverId, deviceHostId, deviceId, platform, active, canInteract, onInputError }: Props = $props();

  let canvas = $state<HTMLCanvasElement | null>(null);
  let textBridge = $state<HTMLInputElement | null>(null);
  let status = $state<DeviceVideoStatus>({ kind: "connecting" });
  let frame = $state<{ width: number; height: number } | null>(null);
  let screenGeneration = 0;
  /** iOS falls back to JPEG when this client cannot decode the H.264 profile. */
  let format = $state<"h264" | "jpeg">(browserVideoCodecs() || platform === "android" ? "h264" : "jpeg");
  let pointerDown = false;

  const target = $derived({ deviceHostId, deviceId });

  $effect(() => {
    const node = canvas;
    if (!node || !active) return;
    const context = node.getContext("2d");
    const currentFormat = format;
    const decoder = new DeviceVideoDecoder(
      {
        present: (source, width, height) => {
          if (!context) return;
          if (node.width !== width || node.height !== height) {
            node.width = width;
            node.height = height;
          }
          // SAFETY: in a browser the decoder only presents VideoFrames and ImageBitmaps, both drawable.
          context.drawImage(source as CanvasImageSource, 0, 0, width, height);
          if (frame?.width !== width || frame?.height !== height) frame = { width, height };
        },
        status: (next) => {
          if (next.kind === "unsupported" && platform === "ios" && currentFormat === "h264") {
            format = "jpeg";
            return;
          }
          status = next;
        },
        screen: (_screen, generation) => {
          screenGeneration = generation;
        },
      },
      currentFormat === "h264" ? browserVideoCodecs() : null,
      (blob) => createImageBitmap(blob),
    );
    const stop = devicesStore.watchFrames(serverId, target, currentFormat, (header, data) => decoder.push(header, data), (message) => {
      status = { kind: "ended", detail: message };
    });
    return () => {
      stop();
      decoder.close();
    };
  });

  const batcher = new DeviceInputBatcher(
    (inputs) => devicesStore.input(serverId, target, screenGeneration, inputs),
    (flush) => requestAnimationFrame(flush),
    (error) => onInputError(deviceErrorMessage(error)),
  );

  function picture() {
    if (!canvas || !frame) return null;
    const rect = canvas.getBoundingClientRect();
    return containedRect({ x: rect.left, y: rect.top, width: rect.width, height: rect.height }, frame.width, frame.height);
  }

  function send(input: DeviceInput) {
    if (!canInteract) return;
    batcher.push(input);
  }

  function onPointerDown(event: PointerEvent) {
    const rect = picture();
    if (!rect || !canInteract) return;
    const point = normalizedPoint(event.clientX, event.clientY, rect);
    if (!point) return;
    canvas?.setPointerCapture(event.pointerId);
    canvas?.focus();
    pointerDown = true;
    send({ kind: "pointer", phase: "down", ...point });
  }

  function onPointerMove(event: PointerEvent) {
    const rect = picture();
    if (!pointerDown || !rect) return;
    send({ kind: "pointer", phase: "move", ...clampedPoint(event.clientX, event.clientY, rect) });
  }

  function onPointerEnd(event: PointerEvent, phase: "up" | "cancel") {
    const rect = picture();
    if (!pointerDown || !rect) return;
    pointerDown = false;
    send({ kind: "pointer", phase, ...clampedPoint(event.clientX, event.clientY, rect) });
  }

  function onWheel(event: WheelEvent) {
    const rect = picture();
    if (!rect || !canInteract) return;
    const point = normalizedPoint(event.clientX, event.clientY, rect);
    if (!point) return;
    event.preventDefault();
    send({ kind: "scroll", ...point, ...scrollDelta(event.deltaX, event.deltaY, rect) });
  }

  function onKey(event: KeyboardEvent, phase: "down" | "up") {
    if (event.target === textBridge) return;
    const input = keyInput(event, phase);
    if (!input || !canInteract) return;
    event.preventDefault();
    send(input);
  }

  function onBridgeInput(event: Event & { currentTarget: HTMLInputElement }) {
    const field = event.currentTarget;
    const text = field.value;
    field.value = "";
    if (text) send({ kind: "text", text });
  }

  function onBridgeKey(event: KeyboardEvent) {
    if (event.key === "Enter" || event.key === "Backspace") {
      event.preventDefault();
      const down = keyInput(event, "down");
      const up = keyInput(event, "up");
      if (down && up) {
        send(down);
        send(up);
      }
    }
  }

  export function focusKeyboard() {
    textBridge?.focus();
  }
</script>

<div class="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden" data-testid="device-stream">
  <canvas
    bind:this={canvas}
    tabindex="0"
    aria-label="Device screen. Click to tap, drag to swipe, type to send keys."
    class="max-h-full max-w-full touch-none rounded-[1.4rem] bg-black object-contain shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring {frame ? '' : 'invisible'} {canInteract ? 'cursor-pointer' : 'cursor-not-allowed'}"
    style:aspect-ratio={frame ? `${frame.width} / ${frame.height}` : undefined}
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={(event) => onPointerEnd(event, "up")}
    onpointercancel={(event) => onPointerEnd(event, "cancel")}
    onlostpointercapture={(event) => onPointerEnd(event, "cancel")}
    onwheel={onWheel}
    onkeydown={(event) => onKey(event, "down")}
    onkeyup={(event) => onKey(event, "up")}
  ></canvas>
  {#if !frame || status.kind !== "streaming"}
    <div class="absolute inset-0 flex items-center justify-center p-6 text-center text-workspace-chrome text-muted-foreground" role="status">
      {#if status.kind === "ended"}
        {status.detail}
      {:else if status.kind === "unsupported"}
        This client cannot decode the device video ({status.codec}). Use a browser with WebCodecs over HTTPS, or the desktop app.
      {:else if frame}
        Reconnecting…
      {:else}
        Connecting to the device…
      {/if}
    </div>
  {/if}
  <input
    bind:this={textBridge}
    class="absolute bottom-0 left-0 h-px w-px opacity-0"
    aria-label="Type on the device"
    autocapitalize="off"
    autocomplete="off"
    spellcheck="false"
    oninput={onBridgeInput}
    onkeydown={onBridgeKey}
  />
</div>

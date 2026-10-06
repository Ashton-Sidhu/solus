<script lang="ts">
  import type { DevicePlatform, DeviceInput } from "@solus/contracts/device-types";
  import { DeviceHubStream } from "@solus/client-core/device-hub-stream";
  import { devicesStore, deviceErrorMessage } from "../../contexts/devices/devices.store.svelte";
  import type { DeviceScreenConfig } from "@solus/contracts/device-types";
  import { DeviceVideoDecoder, browserVideoCodecs, framePlacement, type DeviceVideoStatus } from "./lib/device-video";
  import { DeviceInputBatcher, clampedPoint, containedRect, keyInput, normalizedPoint, scrollDelta, type ScreenPoint } from "./lib/device-input";
  import { resolveDeviceBody } from "./lib/phone-viewer/body-profile";
  import DevicePhoneView from "./DevicePhoneView.svelte";

  /**
   * One device's live screen. It reads the hub stream only while `active`, so a
   * hidden pane decodes nothing and the hub sends nothing. Pointer, wheel and
   * key input go to the device through this client's control lease; the
   * text field forwards a touch keyboard's typing. With `showPhone` the
   * picture is drawn on a 3D body (`DevicePhoneView`); the flat canvas still
   * decodes it and is the 3D view's texture.
   */

  interface Props {
    serverId: string;
    deviceHostId: string;
    deviceId: string;
    platform: DevicePlatform;
    /** The simulator's name: it picks a phone or a tablet body. */
    deviceName: string;
    showPhone: boolean;
    onPhoneUnavailable: () => void;
    active: boolean;
    /** Input is refused while someone else controls the device. */
    canInteract: boolean;
    onInputError: (message: string) => void;
  }

  let { serverId, deviceHostId, deviceId, platform, deviceName, showPhone, onPhoneUnavailable, active, canInteract, onInputError }: Props = $props();

  let canvas = $state<HTMLCanvasElement | null>(null);
  let textBridge = $state<HTMLInputElement | null>(null);
  let status = $state<DeviceVideoStatus>({ kind: "connecting" });
  let frame = $state<{ width: number; height: number } | null>(null);
  let screenConfig = $state<DeviceScreenConfig | null>(null);
  let phoneView = $state<ReturnType<typeof DevicePhoneView> | null>(null);
  const profile = $derived(resolveDeviceBody({
    platform,
    name: deviceName,
    portraitAspect: frame ? Math.min(frame.width, frame.height) / Math.max(frame.width, frame.height) : 0.46,
  }));
  /** iOS falls back to JPEG when this client cannot decode the H.264 profile. */
  let format = $state<"h264" | "jpeg">(browserVideoCodecs() || platform === "android" ? "h264" : "jpeg");
  let pointerDown = false;
  /** The open hub stream; input goes over its socket. */
  let stream: DeviceHubStream | null = null;

  const target = $derived({ deviceHostId, deviceId });

  $effect(() => {
    const node = canvas;
    if (!node || !active) return;
    const context = node.getContext("2d");
    const currentFormat = format;
    let screen: DeviceScreenConfig | null = null;
    const decoder = new DeviceVideoDecoder(
      {
        present: (source, width, height) => {
          if (!context) return;
          const placement = framePlacement(screen, width, height);
          if (node.width !== placement.width || node.height !== placement.height) {
            node.width = placement.width;
            node.height = placement.height;
          }
          context.setTransform(...placement.transform);
          // SAFETY: in a browser the decoder only presents VideoFrames and ImageBitmaps, both drawable.
          context.drawImage(source as CanvasImageSource, 0, 0, width, height);
          context.resetTransform();
          phoneView?.frameUpdated();
          if (frame?.width !== placement.width || frame?.height !== placement.height) frame = { width: placement.width, height: placement.height };
        },
        status: (next) => {
          if (next.kind === "unsupported" && platform === "ios" && currentFormat === "h264") {
            format = "jpeg";
            return;
          }
          status = next;
        },
        screen: (next) => {
          screen = next;
          screenConfig = next;
        },
        needsKeyframe: () => hub.requestKeyframe(),
      },
      currentFormat === "h264" ? browserVideoCodecs() : null,
      (blob) => createImageBitmap(blob),
    );
    const hub = new DeviceHubStream({
      platform,
      format: currentFormat,
      openUrl: () => devicesStore.streamUrl(serverId, target),
      onPacket: (packet, data) => decoder.push(packet, data),
    });
    stream = hub;
    hub.start();
    return () => {
      hub.close();
      if (stream === hub) stream = null;
      decoder.close();
    };
  });

  /** Take control if this client needs it, then send over the hub socket. Toolbar buttons call it too. */
  export async function sendInputs(inputs: DeviceInput[]) {
    await devicesStore.ensureControl(serverId, target);
    if (!stream) throw new Error("The device is not shown.");
    await stream.send(inputs);
  }

  const batcher = new DeviceInputBatcher(
    sendInputs,
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
    // A finger is the primary button. A wheel press or a right click would hold a touch down and drag it.
    if (!rect || !canInteract || event.button !== 0) return;
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
    send({ kind: "scroll", ...point, ...scrollDelta(event.deltaX, event.deltaY, event.deltaMode, rect) });
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

  function onPhoneTouch(phase: "down" | "move" | "up", point: ScreenPoint) {
    send({ kind: "pointer", phase, ...point });
  }

  /** Turn the 3D device back to face the user. */
  export function resetPose() {
    phoneView?.resetPose();
  }

  export function focusKeyboard() {
    textBridge?.focus();
  }
</script>

<div class="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden" data-testid="device-stream">
  <canvas
    bind:this={canvas}
    tabindex={showPhone ? -1 : 0}
    aria-hidden={showPhone || undefined}
    aria-label="Device screen. Click to tap, drag to swipe, type to send keys."
    class="max-h-full max-w-full touch-none rounded-[1.4rem] bg-black object-contain shadow-[shadow:0_0_0_0.5px_var(--hairline-strongest),0_0.125rem_0.25rem_-0.125rem_rgba(0,0,0,0.16),0_1.625rem_3.75rem_-1.625rem_rgba(0,0,0,0.45)] outline-none focus-visible:ring-2 focus-visible:ring-ring {frame && !showPhone ? '' : 'invisible'} {canInteract ? 'cursor-pointer' : 'cursor-not-allowed'}"
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
  {#if showPhone && canvas && frame}
    <DevicePhoneView bind:this={phoneView} source={canvas} {profile} screen={screenConfig}
      onTouch={onPhoneTouch} {onKey} onUnavailable={onPhoneUnavailable} />
  {/if}
  {#if !frame || status.kind !== "streaming"}
    <div class="absolute inset-0 flex items-center justify-center p-6 text-center text-workspace-chrome text-(--solus-text-tertiary)" role="status">
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

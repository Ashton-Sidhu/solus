<script lang="ts">
  import type { DeviceScreenConfig } from "@solus/contracts/device-types";
  import type { PhoneViewer } from "./lib/phone-viewer/phone-viewer";
  import type { DeviceBodyProfile } from "./lib/phone-viewer/body-profile";
  import { createPhoneInteraction } from "./lib/phone-viewer/phone-interaction";
  import { bindPhoneTrackpad } from "./lib/phone-viewer/phone-trackpad";
  import type { ScreenPoint } from "./lib/device-input";

  /**
   * The device screen on a 3D body that the user can turn (adapted from T3
   * Code `apps/web/src/components/device/DevicePhoneViewport.tsx`, MIT). The
   * decoded picture stays on the flat surface's canvas; this view uses it as a
   * texture and renders only when a frame or a gesture changes the picture.
   * three.js loads with the first 3D view, not with the app.
   */

  interface Props {
    /** The flat surface's canvas: the upright device picture. */
    source: HTMLCanvasElement;
    profile: DeviceBodyProfile;
    screen: DeviceScreenConfig | null;
    onTouch: (phase: "down" | "move" | "up", point: ScreenPoint) => void;
    onKey: (event: KeyboardEvent, phase: "down" | "up") => void;
    /** WebGL is missing or its context was lost. The surface shows the flat view. */
    onUnavailable: () => void;
  }

  let { source, profile, screen, onTouch, onKey, onUnavailable }: Props = $props();

  let host = $state<HTMLDivElement | null>(null);
  let canvas = $state<HTMLCanvasElement | null>(null);
  let viewer: PhoneViewer | null = null;
  let interaction: ReturnType<typeof createPhoneInteraction> | null = null;

  // three.js owns the canvas: build the viewer once per canvas, outside Svelte's graph.
  $effect(() => {
    const node = canvas;
    const area = host;
    if (!node || !area) return;
    let disposed = false;
    let trackpad: ReturnType<typeof bindPhoneTrackpad> | null = null;
    const resize = () => {
      const { width, height } = area.getBoundingClientRect();
      viewer?.resize(width, height, window.devicePixelRatio);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(area);
    const blur = () => {
      interaction?.end();
      trackpad?.cancel();
    };
    window.addEventListener("blur", blur);
    void import("./lib/phone-viewer/phone-viewer")
      .then(({ createPhoneViewer }) => {
        if (disposed) return;
        const created = createPhoneViewer({ canvas: node, source, onUnavailable, profile });
        viewer = created;
        created.setScreen(screen, profile);
        interaction = createPhoneInteraction({
          screenPoint: (point, captured) => created.screenPoint(point.x, point.y, captured),
          touch: (phase, point) => onTouch(phase === "begin" ? "down" : phase === "end" ? "up" : "move", point),
          orbit: created.orbit,
          zoomBy: () => {},
          onInteractionActive: created.setInteractionActive,
        });
        trackpad = bindPhoneTrackpad(node, interaction);
        resize();
        created.frameUpdated();
      })
      .catch(() => {
        if (!disposed) onUnavailable();
      });
    return () => {
      disposed = true;
      trackpad?.dispose();
      interaction?.end();
      interaction = null;
      observer.disconnect();
      window.removeEventListener("blur", blur);
      viewer?.dispose();
      viewer = null;
    };
  });

  $effect(() => {
    viewer?.setScreen(screen, profile);
  });

  /** The flat canvas drew a new frame. */
  export function frameUpdated() {
    viewer?.frameUpdated();
  }

  /** Turn the device back to face the user. */
  export function resetPose() {
    viewer?.resetPose();
  }

  export function focus() {
    canvas?.focus();
  }

  function point(event: PointerEvent & { currentTarget: HTMLCanvasElement }) {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
  }
</script>

<div bind:this={host} class="absolute inset-0">
  <div aria-hidden="true" class="pointer-events-none absolute bottom-[6%] left-1/2 h-5 w-2/5 -translate-x-1/2 rounded-full bg-foreground/10 blur-xl"></div>
  <canvas
    bind:this={canvas}
    tabindex="0"
    aria-label="3D device. Drag the screen to tap and swipe. Drag outside it, or swipe with two fingers, to turn the device. Alt-drag turns it from anywhere."
    class="relative size-full touch-none outline-none focus-visible:ring-2 focus-visible:ring-ring"
    onpointerdown={(event) => {
      if (event.button !== 0) return;
      if (!interaction?.begin(event.pointerId, point(event), event.altKey)) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.focus();
    }}
    onpointermove={(event) => interaction?.move(event.pointerId, point(event))}
    onpointerup={(event) => {
      interaction?.move(event.pointerId, point(event));
      interaction?.end(event.pointerId);
    }}
    onpointercancel={(event) => interaction?.end(event.pointerId)}
    onlostpointercapture={(event) => interaction?.end(event.pointerId)}
    onkeydown={(event) => onKey(event, "down")}
    onkeyup={(event) => onKey(event, "up")}
  ></canvas>
</div>

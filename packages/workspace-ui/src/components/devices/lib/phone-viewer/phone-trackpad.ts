// Adapted from T3 Code `apps/web/src/components/device/phoneTrackpad.ts` (MIT, pingdotgg/t3code@77823bd102).
// Solus: no pinch. T3's phone viewport does not pass one either; a pinch only
// stops the browser from zooming the page.
import { phoneWheelNavigation, type createPhoneInteraction } from "./phone-interaction";

/** Canvas-local, non-passive listeners turn wheel and trackpad swipes into orbit and consume browser zoom. */
export function bindPhoneTrackpad(
  canvas: Pick<
    HTMLCanvasElement,
    "addEventListener" | "removeEventListener" | "getBoundingClientRect"
  >,
  interaction: Pick<ReturnType<typeof createPhoneInteraction>, "navigate" | "endWheel">,
) {
  let orbitActive = false;
  let orbitTimer: ReturnType<typeof setTimeout> | null = null;
  const endOrbit = () => {
    if (orbitTimer) clearTimeout(orbitTimer);
    orbitTimer = null;
    if (!orbitActive) return;
    orbitActive = false;
    interaction.endWheel();
  };
  const consume = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const wheel = (event: WheelEvent) => {
    consume(event);
    // Ctrl-wheel is a trackpad pinch: consumed so the page does not zoom.
    if (event.ctrlKey) {
      endOrbit();
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const navigation = phoneWheelNavigation({
      width: rect.width,
      height: rect.height,
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      deltaMode: event.deltaMode,
      ctrlKey: event.ctrlKey,
    });
    if (navigation && interaction.navigate(navigation)) {
      orbitActive = true;
      if (orbitTimer) clearTimeout(orbitTimer);
      // Browsers without a release signal still return to a useful view.
      orbitTimer = setTimeout(endOrbit, 1200);
    }
  };
  // Safari reports a trackpad pinch as gesture events rather than Ctrl-wheel.
  const gesture = (event: Event) => {
    consume(event);
    endOrbit();
  };
  canvas.addEventListener("wheel", wheel, { passive: false });
  canvas.addEventListener("gesturestart", gesture, { passive: false });
  canvas.addEventListener("gesturechange", consume, { passive: false });
  canvas.addEventListener("gestureend", consume, { passive: false });
  return {
    endOrbit,
    cancel: endOrbit,
    dispose() {
      canvas.removeEventListener("wheel", wheel);
      canvas.removeEventListener("gesturestart", gesture);
      canvas.removeEventListener("gesturechange", consume);
      canvas.removeEventListener("gestureend", consume);
      endOrbit();
    },
  };
}

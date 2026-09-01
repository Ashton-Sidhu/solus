<script lang="ts">
  /**
   * The window's close / minimise / zoom controls.
   *
   * On the desktop app macOS draws these itself, over the sidebar's top-left
   * corner, and the renderer only reserves the space (`--solus-traffic-light-
   * inset`). The demo runs in a page with no window of its own, so it paints
   * them at the position `trafficLightPosition` puts them at — leaving the
   * sidebar it sits over the same corner it has in the app.
   *
   * Decoration only: the demo has no window to close, so they take no pointer.
   */
</script>

<div class="pointer-events-none fixed top-[18px] left-4 z-[9999] flex items-center gap-2" aria-hidden="true">
  <span class="size-3 rounded-full bg-[#E46B5D] shadow-[0_0_0_0.5px_rgba(0,0,0,0.12)_inset]"></span>
  <span class="size-3 rounded-full bg-[#E2B34E] shadow-[0_0_0_0.5px_rgba(0,0,0,0.12)_inset]"></span>
  <span class="size-3 rounded-full bg-[#68B36B] shadow-[0_0_0_0.5px_rgba(0,0,0,0.12)_inset]"></span>
</div>

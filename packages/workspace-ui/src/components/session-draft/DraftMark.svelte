<script lang="ts">
  /** The Solus mark behind the new-tab home, drawn large in halftone dots and
   *  cut by the bottom right corner of the pane, in the colours of the sky
   *  scene. It is one painted box: the scene's two colours as a gradient, shown
   *  only where four masks agree (the dots, the shape of the mark, a clearing
   *  around the composer, and a fade at the top). So it costs no elements for
   *  the dots, and nothing here animates. The dots keep one size at every pane
   *  size; only the mark grows. The colours go over the page's own background,
   *  so the mark follows the theme (docs/plans/sidebar-places-and-sky.md). */
  import type { SkyScene } from "../../lib/sky-scene";

  let { scene }: { scene: SkyScene } = $props();
</script>

<div class="draft-mark pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
  <div class="draft-mark-art absolute inset-0" data-scene={scene}></div>
</div>

<style>
  /* A size container, so the art can take its size from the smaller of the
     pane's width and height. It holds only the art. */
  .draft-mark {
    container-type: size;
  }

  .draft-mark-art {
    /* The composer's measure on the full-page draft (SessionDraftPane). */
    --draft-mark-measure: max(min(60%, 50rem), min(100%, 30rem));
    /* The mark is about half of the pane's width, held to its height so a
       short pane does not fill with it. */
    --draft-mark-size: clamp(22rem, min(54cqw, 118cqh), 62rem);
    background: linear-gradient(
      to right,
      var(--draft-mark-near) 15%,
      var(--draft-mark-far) 85%
    );
    /* Top to bottom: the fade under the pane's header, the halftone dots, the
       mark (resources/tray-master.svg), and the clearing over the headline,
       the composer, and the menus under it. The result is the dots, inside the
       mark, less the clearing, under the fade. */
    mask-image:
      linear-gradient(to bottom, transparent, black 3rem),
      url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 13.856'%3E%3Ccircle r='1.7'/%3E%3Ccircle cx='8' r='1.7'/%3E%3Ccircle cx='4' cy='6.928' r='1.7'/%3E%3Ccircle cy='13.856' r='1.7'/%3E%3Ccircle cx='8' cy='13.856' r='1.7'/%3E%3C/svg%3E"),
      url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 18 18'%3E%3Ccircle cx='9' cy='9' r='4.8'/%3E%3Cg fill='none' stroke='%23000' stroke-width='1.7' stroke-linecap='round'%3E%3Cpath d='M9,1 A8,8 0 0 1 17,9'/%3E%3Cpath d='M15.72,14.44 A8,8 0 0 1 6.44,16.68'/%3E%3Cpath d='M2.28,14.44 A8,8 0 0 1 1,6.44'/%3E%3C/g%3E%3C/svg%3E"),
      radial-gradient(ellipse closest-side, rgb(0 0 0 / 0.9) 50%, transparent);
    mask-size:
      auto,
      0.5rem 0.866rem,
      var(--draft-mark-size) var(--draft-mark-size),
      calc(var(--draft-mark-measure) * 1.44) 16.5rem;
    /* The corner cuts the mark: a little of it is past the right edge, and
       more of it is below the bottom edge. */
    mask-position:
      0 0,
      0 0,
      right calc(var(--draft-mark-size) * -0.083) bottom
        calc(var(--draft-mark-size) * -0.22),
      50% calc(50% + 0.875rem);
    mask-repeat: no-repeat, repeat, no-repeat, no-repeat;
    mask-composite: intersect, intersect, subtract, add;
  }

  /* `near` is the colour toward the sidebar's sky and `far` is the colour
     toward the corner, where most of the mark is. */
  .draft-mark-art[data-scene="dawn"] {
    --draft-mark-near: color-mix(in oklch, #d97757 50%, transparent);
    --draft-mark-far: color-mix(in oklch, #d4af6a 50%, transparent);
  }

  .draft-mark-art[data-scene="day"] {
    --draft-mark-near: color-mix(in oklch, #d4af6a 50%, transparent);
    --draft-mark-far: color-mix(in oklch, #7fb2e5 50%, transparent);
  }

  .draft-mark-art[data-scene="dusk"] {
    --draft-mark-near: color-mix(in oklch, #7b5ea7 50%, transparent);
    --draft-mark-far: color-mix(in oklch, #e07a4f 50%, transparent);
  }

  .draft-mark-art[data-scene="night"] {
    --draft-mark-near: color-mix(in oklch, #4c5bd4 50%, transparent);
    --draft-mark-far: color-mix(in oklch, #7b5ea7 50%, transparent);
  }
</style>

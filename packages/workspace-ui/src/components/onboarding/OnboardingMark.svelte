<script lang="ts">
  /**
   * The Solus corona, opening the app for the first time.
   *
   * The mark is drawn as two independent layers rather than as one scaled SVG,
   * because they have to move differently: the core comes at the viewer while
   * the rings blow past it and off the screen. Same geometry as
   * `WorkspaceMark` — core r=6.6, arcs at r=11 on a 32×32 box — kept in step by
   * hand rather than by importing it, since that primitive is one flat shape
   * with nothing to animate separately.
   *
   * Both layers animate transform and opacity only, and both declare
   * `will-change: transform`. That is load-bearing at this scale: without it the
   * compositor re-rasterizes the artwork as it grows, and a 60× ring is a very
   * expensive raster. With it, the layer is rastered once and the texture is
   * transformed.
   */
  let { class: className = "" }: { class?: string } = $props();
</script>

<div class="relative {className}" aria-hidden="true">
  <!-- The rings leave first and fastest, so they read as passing the viewer. -->
  <svg
    class="onboarding-mark-rings absolute inset-0 size-full"
    viewBox="0 0 32 32"
    fill="none"
  >
    <g stroke="#D97757" stroke-width="2.2" stroke-linecap="round">
      <path d="M16,5 A11,11 0 0 1 27,16" />
      <path d="M25.24,23.48 A11,11 0 0 1 12.48,26.56" />
      <path d="M6.76,23.48 A11,11 0 0 1 5,12.48" />
    </g>
  </svg>

  <!-- The core is a plain div: a filled circle needs no SVG, and a border-radius
       box is the cheapest thing a compositor can scale. 13.2/32 of the box. -->
  <span
    class="onboarding-mark-core absolute left-1/2 top-1/2 rounded-full"
    style="width: 41.25%; height: 41.25%; background: #b45a3c"
  ></span>
</div>

<style>
  .onboarding-mark-core,
  .onboarding-mark-rings {
    will-change: transform, opacity;
  }

  .onboarding-mark-core {
    /* Centred by transform rather than by margins, so the animation's own
       translate can carry the centring instead of fighting it. */
    animation: onboarding-mark-core 2.6s both;
  }
  .onboarding-mark-rings {
    animation: onboarding-mark-rings 2.6s both;
  }

  @keyframes onboarding-mark-core {
    0% {
      opacity: 0;
      transform: translate3d(-50%, -50%, 0) scale(0.3);
      animation-timing-function: cubic-bezier(0.16, 1, 0.3, 1);
    }
    18% {
      opacity: 1;
      transform: translate3d(-50%, -50%, 0) scale(1);
      animation-timing-function: ease-out;
    }
    34% {
      opacity: 1;
      transform: translate3d(-50%, -50%, 0) scale(1);
      /* Accelerating into the viewer: slow off the mark, then gone. */
      animation-timing-function: cubic-bezier(0.7, 0, 0.9, 0.25);
    }
    88% {
      opacity: 1;
    }
    100% {
      opacity: 0;
      transform: translate3d(-50%, -50%, 0) scale(26);
    }
  }

  /* The rings share the settle, then break away — further, sooner, and faded
     out before the core fills the screen, so they clear the edges first. */
  @keyframes onboarding-mark-rings {
    0% {
      opacity: 0;
      transform: scale(0.3);
      animation-timing-function: cubic-bezier(0.16, 1, 0.3, 1);
    }
    18% {
      opacity: 1;
      transform: scale(1);
      animation-timing-function: ease-out;
    }
    34% {
      opacity: 1;
      transform: scale(1);
      animation-timing-function: cubic-bezier(0.6, 0, 0.85, 0.3);
    }
    72% {
      opacity: 0.55;
    }
    100% {
      opacity: 0;
      transform: scale(64);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .onboarding-mark-core {
      animation: none;
      transform: translate3d(-50%, -50%, 0);
    }
    .onboarding-mark-rings {
      animation: none;
    }
  }
</style>

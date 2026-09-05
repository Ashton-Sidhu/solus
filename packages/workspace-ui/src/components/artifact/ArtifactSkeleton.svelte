<script lang="ts">
  /**
   * The pending stage of a render: shown from the moment `render_artifact`
   * starts until the HTML lands.
   */
  let { skipMotion = false }: { skipMotion?: boolean } = $props();
</script>

<div
  class="py-2 {skipMotion ? '' : 'animate-msg-in-side'}"
  data-testid="artifact-generating"
>
  <!-- Anticipatory skeleton: faux content silhouettes (title, canvas, caption)
       on a tall warm "stage". Bones rest neutral — the brand colour never sits
       as a fill, it only travels: a 10% accent highlight sweeping the bones
       plus a 2px indeterminate hairline. The header names the payload in
       words, because a rectangle of washes is the one moment the reader
       cannot tell what is arriving. -->
  <div
    class="artifact-skeleton"
    role="status"
    aria-label="Rendering visualization"
  >
    <div class="artifact-skeleton__head">
      <span class="artifact-skeleton__kicker">Artifact</span>
      <span class="artifact-skeleton__status">rendering</span>
    </div>
    <div class="artifact-skeleton__rule"></div>
    <div class="artifact-skeleton__body">
      <div class="sk-bar sk-title"></div>
      <div class="sk-bar sk-block"></div>
      <div class="sk-bar sk-line"></div>
      <div class="sk-bar sk-line2"></div>
    </div>
    <div class="artifact-skeleton__track">
      <div class="artifact-skeleton__progress"></div>
    </div>
  </div>
</div>

<style>
  /* Tall warm "stage" the visualization will land on — reserves a generous
     footprint so the render reads as imminent rather than a short box. A faint
     parchment wash + hairline give it presence without competing with the
     artifact that swaps in. */
  .artifact-skeleton {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    /* Track the window height (svh) so the reserved footprint scales with the
       device, bounded so it never gets cramped on short windows or oversized on
       tall displays. */
    min-height: clamp(11rem, 24svh, 15rem);
    border-radius: 1rem;
    background: color-mix(in srgb, var(--solus-art-surface) 60%, transparent);
    border: 0.0625rem solid var(--solus-art-border);
  }

  .artifact-skeleton__head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.8125rem 1.0625rem 0.6875rem;
  }

  .artifact-skeleton__kicker {
    font-size: var(--text-xs);
    font-weight: 500;

    text-transform: uppercase;
    color: var(--muted-foreground);
    opacity: 0.7;
  }

  .artifact-skeleton__status {
    margin-left: auto;
    font-size: var(--text-xs);
    color: var(--muted-foreground);
    animation: artifact-sk-breathe 2.6s ease-in-out infinite;
  }

  .artifact-skeleton__rule {
    height: 0.0625rem;
    background: var(--solus-tx-rule);
  }

  .artifact-skeleton__body {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 0.6875rem;
    padding: 1rem 1rem 0.9375rem;
  }

  /* Each bone rests at a quiet ink wash; the accent exists only inside the
     highlight travelling across it. Ink tints mix in srgb, never oklch —
     transparent's oklch hue is 0 and a polar mix turns warm brown pink. The
     sweep runs on the transcript's 2.4s shimmer clock, rows offset by -0.4s so
     the highlight reads as one pass moving down the stage. */
  .sk-bar {
    --sk-ink: 6%;
    border-radius: 9999px;
    background-image: linear-gradient(
      90deg,
      color-mix(in srgb, var(--solus-text-primary) var(--sk-ink), transparent) 0%,
      color-mix(in srgb, var(--solus-accent) 10%, transparent) 45%,
      color-mix(in srgb, var(--solus-text-primary) var(--sk-ink), transparent) 90%
    );
    background-size: 260% 100%;
    animation: artifact-sk-shim 2.4s linear infinite;
  }

  .sk-title {
    --sk-ink: 7%;
    width: 46%;
    height: 0.6875rem;
  }

  /* The "canvas" block grows to fill the stage so the footprint stays tall. */
  .sk-block {
    --sk-ink: 4%;
    flex: 1;
    min-height: 4.5rem;
    border-radius: 0.5rem;
    box-shadow: inset 0 0 0 0.03125rem
      color-mix(in srgb, var(--solus-text-primary) 9%, transparent);
    animation-delay: -0.4s;
  }

  .sk-line {
    width: 92%;
    height: 0.5625rem;
    animation-delay: -0.8s;
  }

  .sk-line2 {
    width: 58%;
    height: 0.5625rem;
    animation-delay: -1.2s;
  }

  .artifact-skeleton__track {
    height: 0.125rem;
    overflow: hidden;
    background: color-mix(in srgb, var(--solus-text-primary) 6%, transparent);
  }

  .artifact-skeleton__progress {
    height: 100%;
    width: 34%;
    background: var(--solus-accent);
    opacity: 0.5;
    animation: artifact-sk-indet 1.6s cubic-bezier(0.5, 0, 0.5, 1) infinite;
  }

  @media (max-width: 40rem) {
    .artifact-skeleton {
      min-height: clamp(9.5rem, 30svh, 13rem);
      border-radius: min(2vw, 0.75rem);
    }

    .artifact-skeleton__body {
      gap: 0.625rem;
      padding: 0.875rem 0.875rem 0.8125rem;
    }
  }

  @keyframes artifact-sk-shim {
    from {
      background-position: 200% 0;
    }
    to {
      background-position: -100% 0;
    }
  }

  @keyframes artifact-sk-breathe {
    0%,
    100% {
      opacity: 0.35;
    }
    50% {
      opacity: 0.85;
    }
  }

  @keyframes artifact-sk-indet {
    from {
      transform: translateX(-45%);
    }
    to {
      transform: translateX(245%);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .sk-bar {
      animation: none;
      background-image: none;
      background-color: color-mix(
        in srgb,
        var(--solus-text-primary) var(--sk-ink),
        transparent
      );
    }
    .artifact-skeleton__status {
      animation: none;
      opacity: 0.6;
    }
    .artifact-skeleton__progress {
      animation: none;
      opacity: 0.35;
    }
  }
</style>

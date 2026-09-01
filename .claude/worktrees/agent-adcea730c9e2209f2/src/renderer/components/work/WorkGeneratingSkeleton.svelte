<script lang="ts">
  interface Props {
    workType?: "doc" | "slides" | "diagram";
  }
  // Kept for call-site compatibility; the skeleton is type-agnostic so every
  // work type renders the same anticipatory silhouette as the HTML artifact.
  let {}: Props = $props();
</script>

<div class="py-2 animate-msg-in-side" data-testid="work-generating">
  <!-- Anticipatory skeleton: faux content silhouettes (title, canvas, caption)
       sit on a tall warm "stage", and a brand-accent fill wipes across each in
       sequence — so a rich work reads as streaming into place rather than a
       short box blinking. Matches the HTML artifact skeleton exactly. -->
  <div class="artifact-skeleton" role="status" aria-label="Generating work">
    <div class="sk-row sk-title"><span class="sk-fill"></span></div>
    <div class="sk-row sk-block"><span class="sk-fill"></span></div>
    <div class="sk-row sk-line"><span class="sk-fill"></span></div>
    <div class="sk-row sk-line2"><span class="sk-fill"></span></div>
  </div>
</div>

<style>
  /* Tall warm "stage" the work will land on — reserves a generous footprint so
     the render reads as imminent rather than a short box. */
  .artifact-skeleton {
    display: flex;
    flex-direction: column;
    gap: 0.8125rem;
    min-height: clamp(11rem, 24svh, 15rem);
    padding: 1.5rem;
    border-radius: 0.75rem;
    background: color-mix(in srgb, var(--solus-art-surface) 60%, transparent);
    border: 0.0625rem solid var(--solus-art-border);
  }

  /* Each silhouette bone. A brand-accent fill wipes across it left→right; the
     bones are staggered so content reads as streaming into place in sequence. */
  .sk-row {
    position: relative;
    overflow: hidden;
    border-radius: 0.4375rem;
    background: color-mix(in srgb, var(--solus-text-primary) 9%, transparent);
  }

  .sk-fill {
    position: absolute;
    inset: 0;
    transform-origin: left;
    transform: scaleX(0);
    background: color-mix(in srgb, var(--solus-accent) 30%, transparent);
    animation: work-wipe 2.8s ease-in-out infinite;
  }

  .sk-title {
    width: 46%;
    height: 0.8125rem;
  }

  /* The "canvas" block grows to fill the stage so the footprint stays tall. */
  .sk-block {
    flex: 1;
    min-height: 4.5rem;
  }

  .sk-line {
    width: 80%;
    height: 0.6875rem;
  }

  .sk-line2 {
    width: 60%;
    height: 0.6875rem;
  }

  .sk-title .sk-fill {
    animation-delay: 0s;
  }
  .sk-block .sk-fill {
    animation-delay: 0.2s;
  }
  .sk-line .sk-fill {
    animation-delay: 0.4s;
  }
  .sk-line2 .sk-fill {
    animation-delay: 0.55s;
  }

  @keyframes work-wipe {
    0% {
      transform: scaleX(0);
      opacity: 1;
    }
    45%,
    70% {
      transform: scaleX(1);
      opacity: 1;
    }
    100% {
      transform: scaleX(1);
      opacity: 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .sk-fill {
      animation: none;
      transform: scaleX(1);
      opacity: 0.5;
    }
  }

  @media (max-width: 40rem) {
    .artifact-skeleton {
      gap: 0.625rem;
      min-height: clamp(9.5rem, 30svh, 13rem);
      padding: 1.125rem;
      border-radius: min(2vw, 0.75rem);
    }
  }
</style>

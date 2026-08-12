<script lang="ts">
  interface Props {
    workType?: "doc" | "slides" | "diagram";
  }
  let { workType = "doc" }: Props = $props();

  const kickers = { doc: "Document", slides: "Slides", diagram: "Diagram" };
  const kicker = $derived(kickers[workType] ?? "Document");
</script>

<div class="py-2 animate-msg-in-side" data-testid="work-generating">
  <!-- The placeholder keeps the ref card's silhouette — same chassis, kicker
       header, hairline, content bones — so nothing reflows when the card lands.
       Bones rest neutral (foreground ink only); the brand colour never sits as
       a fill, it only travels: a 10% accent highlight sweeping the bones plus a
       2px indeterminate hairline along the bottom edge. -->
  <div
    class="work-skeleton mx-auto flex w-[88%] flex-col overflow-hidden rounded-2xl"
    role="status"
    aria-label="Generating {kicker.toLowerCase()}"
  >
    <div class="flex items-center gap-2 px-[1.0625rem] pt-[0.8125rem] pb-[0.6875rem]">
      <span class="work-skeleton__kicker">{kicker}</span>
      <span class="flex-1"></span>
      <span class="work-skeleton__status font-mono">generating</span>
    </div>
    <div class="work-skeleton__rule"></div>
    <div class="flex flex-1 flex-col gap-[0.6875rem] px-4 pt-4 pb-[0.9375rem]">
      <div class="sk-bar sk-heading"></div>
      <div class="sk-bar sk-block"></div>
      <div class="sk-bar sk-line"></div>
      <div class="sk-bar sk-line2"></div>
    </div>
    <div class="work-skeleton__track">
      <div class="work-skeleton__progress"></div>
    </div>
  </div>
</div>

<style>
  .work-skeleton {
    min-height: clamp(11rem, 24svh, 15rem);
    /* Same shell as ConversationRefCard so the swap is seamless. */
    background: var(--solus-tx-card-bg);
    box-shadow: var(--solus-tx-card-shadow);
  }

  .work-skeleton__kicker {
    font-size: 0.75rem;
    font-weight: 500;

    text-transform: uppercase;
    color: var(--muted-foreground);
    opacity: 0.7;
  }

  .work-skeleton__status {
    font-size: 0.75rem;
    color: var(--muted-foreground);
    animation: work-sk-breathe 2.6s ease-in-out infinite;
  }

  .work-skeleton__rule {
    height: 0.0625rem;
    background: var(--solus-tx-rule);
  }

  /* Each bone rests at a quiet ink wash; the accent exists only inside the
     highlight travelling across it. Ink tints mix in srgb, never oklch —
     transparent's oklch hue is 0 and a polar mix turns warm brown pink. The
     sweep runs on the transcript's 2.4s shimmer clock, rows offset by -0.4s so
     the highlight reads as one pass moving down the document. */
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
    animation: work-sk-shim 2.4s linear infinite;
  }

  .sk-heading {
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

  .work-skeleton__track {
    height: 0.125rem;
    overflow: hidden;
    background: color-mix(in srgb, var(--solus-text-primary) 6%, transparent);
  }

  .work-skeleton__progress {
    height: 100%;
    width: 34%;
    background: var(--solus-accent);
    opacity: 0.5;
    animation: work-sk-indet 1.6s cubic-bezier(0.5, 0, 0.5, 1) infinite;
  }

  @keyframes work-sk-shim {
    from {
      background-position: 200% 0;
    }
    to {
      background-position: -100% 0;
    }
  }

  @keyframes work-sk-breathe {
    0%,
    100% {
      opacity: 0.35;
    }
    50% {
      opacity: 0.85;
    }
  }

  @keyframes work-sk-indet {
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
    .work-skeleton__status {
      animation: none;
      opacity: 0.6;
    }
    .work-skeleton__progress {
      animation: none;
      opacity: 0.35;
    }
  }

  @media (max-width: 40rem) {
    .work-skeleton {
      min-height: clamp(9.5rem, 30svh, 13rem);
      border-radius: min(2vw, 0.75rem);
    }
  }
</style>

<script lang="ts">
  /**
   * The Draw intro, desktop first launch only (docs/plans/one-page-onboarding.md
   * decision 8), 2.7 s in all:
   * - 0–1.05 s: the core fades up while the three arcs draw on, clockwise, one
   *   after the other. Slow enough to read as drawing; faster looked like a glitch.
   * - 1.1–1.8 s: the lockup, the mark and "Solus", with the line under it; it holds to 2.2 s.
   * - 2.2–2.7 s: the mark moves up into the page and the cover fades out over it.
   * It lies over the page, which is already laid out behind it. Any key or
   * click ends it (the page handles keys); reduced motion never shows it.
   * Transform, opacity, and stroke-dashoffset only, and nothing repeats.
   */
  let { onend }: { onend: () => void } = $props();

  function onAnimationEnd(event: AnimationEvent) {
    if (event.target === event.currentTarget) onend();
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="intro-cover fixed inset-0 z-30 flex flex-col items-center justify-center gap-4.5"
  role="presentation"
  onclick={onend}
  onanimationend={onAnimationEnd}
>
  <div class="intro-lockup flex items-center gap-4">
    <!-- The brand mark keeps its own colours, as `WorkspaceMark` does. -->
    <svg class="intro-mark size-14 shrink-0" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <circle class="intro-core" cx="16" cy="16" r="6.6" fill="#B45A3C" />
      <g stroke="#D97757" stroke-width="2.2" stroke-linecap="round">
        <path class="intro-arc" pathLength="1" d="M16,5 A11,11 0 0 1 27,16" />
        <path class="intro-arc" pathLength="1" d="M25.24,23.48 A11,11 0 0 1 12.48,26.56" style="animation-delay: 0.45s" />
        <path class="intro-arc" pathLength="1" d="M6.76,23.48 A11,11 0 0 1 5,12.48" style="animation-delay: 0.7s" />
      </g>
    </svg>
    <span class="intro-word text-[48px] leading-13 font-semibold tracking-[-0.035em] text-(--solus-text-primary)">Solus</span>
  </div>
  <p class="intro-line m-0 text-[16px] leading-6 text-(--solus-text-tertiary)">Direct your agents from anywhere.</p>
</div>

<style>
  .intro-cover {
    /* The same opaque composite as the page: --background is translucent in dark mode. */
    background: linear-gradient(var(--background), var(--background)) var(--solus-edge-bg);
    animation: intro-cover-out 0.5s ease-in 2.2s both;
  }
  /* The mark starts centred: half the word and the gap to its right. */
  .intro-mark {
    animation:
      intro-mark-settle 0.55s cubic-bezier(0.16, 1, 0.3, 1) 1.1s both,
      intro-mark-leave 0.5s cubic-bezier(0.7, 0, 0.84, 0) 2.2s forwards;
  }
  .intro-core {
    transform-origin: 16px 16px;
    animation: intro-core-up 0.4s ease-out both;
  }
  .intro-arc {
    stroke-dasharray: 1;
    animation: intro-arc-draw 0.35s ease-in-out 0.2s both;
  }
  .intro-word,
  .intro-line {
    animation: intro-word-in 0.5s cubic-bezier(0.16, 1, 0.3, 1) 1.15s both;
  }
  .intro-line {
    animation-delay: 1.3s;
  }

  @keyframes intro-core-up {
    from { opacity: 0; transform: scale(0.75); }
    to { opacity: 1; transform: none; }
  }
  @keyframes intro-arc-draw {
    from { stroke-dashoffset: 1; }
    to { stroke-dashoffset: 0; }
  }
  @keyframes intro-mark-settle {
    from { transform: translate3d(4.75rem, 0, 0); }
    to { transform: none; }
  }
  @keyframes intro-mark-leave {
    from { transform: none; }
    to { transform: translate3d(0, -12rem, 0) scale(0.64); opacity: 0; }
  }
  @keyframes intro-word-in {
    from { opacity: 0; transform: translate3d(-0.5rem, 0, 0); }
    to { opacity: 1; transform: none; }
  }
  @keyframes intro-cover-out {
    from { opacity: 1; }
    to { opacity: 0; }
  }
</style>

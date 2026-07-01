<script lang="ts">
  import type { SessionProgress } from "../../../shared/types";

  interface Props {
    progress: SessionProgress;
    isRunning: boolean;
    progressAllDone: boolean;
    progressFraction: number;
    progressHeader: string | null;
    stepsOpen: boolean;
    expanded: boolean;
    openSteps: () => void;
    closeSteps: () => void;
  }

  let {
    progress,
    isRunning,
    progressAllDone,
    progressFraction,
    progressHeader,
    stepsOpen,
    expanded,
    openSteps,
    closeSteps,
  }: Props = $props();

  function marquee(node: HTMLElement) {
    const measure = () => {
      const inner = node.firstElementChild as HTMLElement | null;
      if (!inner) return;
      const overflow = Math.ceil(inner.offsetWidth - node.clientWidth);
      if (overflow > 1) {
        node.classList.add("is-truncated");
        node.style.setProperty("--scroll", `${overflow}px`);
        node.style.setProperty(
          "--marquee-dur",
          `${Math.max(0.8, overflow / 90).toFixed(2)}s`,
        );
      } else {
        node.classList.remove("is-truncated");
        node.style.removeProperty("--scroll");
        node.style.removeProperty("--marquee-dur");
      }
    };
    requestAnimationFrame(measure);
  }

  function scrollToActiveStep(node: HTMLElement) {
    node
      .querySelector(".step-dot-in_progress")
      ?.closest("li")
      ?.scrollIntoView({ block: "nearest" });
  }
</script>

{#if stepsOpen}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="steps-pop"
    role="group"
    aria-label="Task steps"
    use:scrollToActiveStep
    onmouseenter={openSteps}
    onmouseleave={closeSteps}
  >
    <div class="steps-head">
      <span class="steps-head-label">Steps</span>
      <span class="steps-head-count tabular-nums"
        >{progress.currentStep}/{progress.totalSteps}</span
      >
    </div>
    <ul class="steps-list" role="list">
      {#each progress.todos as todo, i (i)}
        <li class="step-row">
          <span class="step-marker" aria-hidden="true">
            <span
              class="step-dot step-dot-{todo.status} {todo.status === 'in_progress' && isRunning
                ? 'step-dot-live'
                : ''}"
            ></span>
            {#if i < progress.todos.length - 1}
              <span class="step-line step-line-{todo.status}"></span>
            {/if}
          </span>
          <span class="step-label step-label-{todo.status}" use:marquee>
            <span class="sl-inner">{todo.content}</span>
          </span>
        </li>
      {/each}
    </ul>
  </div>
{/if}

<button
  class="progress-toggle stagger-item"
  class:progress-toggle-active={stepsOpen}
  class:progress-toggle-done={progressAllDone}
  style="--progress:{progressFraction};--item-index:-1"
  tabindex={expanded ? 0 : -1}
  aria-expanded={stepsOpen}
  aria-haspopup="true"
  aria-label={`Progress: step ${progress.currentStep} of ${progress.totalSteps}`}
  onmouseenter={openSteps}
  onmouseleave={closeSteps}
  onfocus={openSteps}
  onblur={closeSteps}
>
  <span
    class="pt-fill {isRunning && !progressAllDone ? 'pt-fill-live' : ''}"
    aria-hidden="true"
  ></span>
  <span class="pt-dial" aria-hidden="true">
    <svg class="pt-svg" viewBox="0 0 36 36">
      <circle class="pt-track" cx="18" cy="18" r="16.5" />
      <circle
        class="pt-arc {isRunning && !progressAllDone ? 'pt-arc-live' : ''}"
        cx="18"
        cy="18"
        r="16.5"
        pathLength="100"
        stroke-dasharray="100"
        style="stroke-dashoffset:{100 - progressFraction * 100}"
      />
    </svg>
    <span class="pt-count tabular-nums"
      >{progress.currentStep}<span class="pt-sep">/</span>{progress.totalSteps}</span
    >
  </span>
  <span class="pt-text">
    <span class="pt-count-text tabular-nums"
      >{progress.currentStep}<span class="pt-sep">/</span>{progress.totalSteps}</span
    >
    {#if progressHeader}
      <span class="pt-label">{progressHeader}</span>
    {/if}
  </span>
</button>

<style>
  .progress-toggle {
    position: relative;
    overflow: hidden;
    display: inline-flex;
    align-items: center;
    gap: calc(0.4375rem * var(--orb-scale));
    min-height: var(--orb-btn-min);
    padding: 0 calc(0.75rem * var(--orb-scale));
    border-radius: 624.9375rem;
    border: 0.0313rem solid
      color-mix(in srgb, var(--solus-container-border) 45%, transparent);
    background: linear-gradient(
      180deg,
      color-mix(in srgb, var(--solus-container-bg) 22%, transparent) 0%,
      color-mix(in srgb, var(--solus-container-bg) 16%, transparent) 100%
    );
    backdrop-filter: blur(1.25rem) saturate(1.8);
    -webkit-backdrop-filter: blur(1.25rem) saturate(1.8);
    box-shadow:
      inset 0 0.0625rem 0 0 color-mix(in srgb, white 8%, transparent),
      0 0.125rem 0.375rem rgba(0, 0, 0, 0.06);
    cursor: pointer;
    transition:
      box-shadow 0.15s ease,
      border-color 0.15s ease,
      transform 0.15s cubic-bezier(0.16, 1, 0.3, 1);
  }
  :global(.dark) .progress-toggle {
    background: linear-gradient(
      180deg,
      color-mix(in srgb, var(--solus-container-bg) 26%, transparent) 0%,
      color-mix(in srgb, var(--solus-container-bg) 18%, transparent) 100%
    );
    border: 0.0313rem solid color-mix(in srgb, white 8%, transparent);
    box-shadow:
      inset 0 0.0625rem 0 0 color-mix(in srgb, white 4%, transparent),
      0 0.125rem 0.375rem rgba(0, 0, 0, 0.2);
  }
  .progress-toggle:hover {
    box-shadow:
      inset 0 0.0625rem 0 0 color-mix(in srgb, white 10%, transparent),
      0 0.125rem 0.5rem rgba(0, 0, 0, 0.1);
  }
  .progress-toggle:active {
    transform: scale(0.96);
  }
  .progress-toggle:focus-visible {
    outline: none;
    box-shadow:
      inset 0 0.0625rem 0 0 color-mix(in srgb, white 10%, transparent),
      0 0 0 0.1875rem color-mix(in srgb, var(--solus-accent) 18%, transparent);
  }
  .progress-toggle-active {
    border-color: color-mix(in srgb, var(--solus-accent) 24%, transparent);
  }
  .progress-toggle-done {
    opacity: 0.9;
  }
  .progress-toggle-done:hover {
    opacity: 1;
  }
  /* Completed → the fill (pill) and ring (circle) shift to the success green. */
  .progress-toggle-done .pt-arc {
    stroke: var(--solus-status-complete);
  }
  .progress-toggle-done .pt-fill {
    background: linear-gradient(
      90deg,
      color-mix(in srgb, var(--solus-status-complete) 11%, transparent) 0%,
      color-mix(in srgb, var(--solus-status-complete) 19%, transparent) 100%
    );
    border-right-color: color-mix(
      in srgb,
      var(--solus-status-complete) 32%,
      transparent
    );
  }
  .pt-fill {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 100%;
    transform-origin: left center;
    transform: scaleX(var(--progress, 0));
    background: linear-gradient(
      90deg,
      color-mix(in srgb, var(--solus-accent) 9%, transparent) 0%,
      color-mix(in srgb, var(--solus-accent) 16%, transparent) 100%
    );
    border-right: 0.0313rem solid
      color-mix(in srgb, var(--solus-accent) 28%, transparent);
    transition: transform 0.7s cubic-bezier(0.16, 1, 0.3, 1);
    pointer-events: none;
  }
  .pt-fill-live::after {
    content: "";
    position: absolute;
    inset: 0;
    background: linear-gradient(
      90deg,
      transparent 0%,
      color-mix(in srgb, var(--solus-accent) 18%, transparent) 50%,
      transparent 100%
    );
    background-size: 200% 100%;
    animation: pbi-flow 2.6s ease-in-out infinite;
  }
  .pt-dial {
    display: none;
    position: relative;
    flex-shrink: 0;
    width: calc(1.75rem * var(--orb-scale));
    height: calc(1.75rem * var(--orb-scale));
  }
  /* Smooth anti-aliased stroke ring (round caps) — matches the elegance of the
     pill's horizontal fill, where a masked conic gradient read as jagged. */
  .pt-svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
    transform: rotate(-90deg);
  }
  .pt-track {
    fill: none;
    stroke: color-mix(in srgb, var(--solus-text-tertiary) 16%, transparent);
    stroke-width: 2.75;
  }
  .pt-arc {
    fill: none;
    stroke: color-mix(in srgb, var(--solus-accent) 85%, transparent);
    stroke-width: 2.75;
    stroke-linecap: round;
    transition: stroke-dashoffset 0.7s cubic-bezier(0.16, 1, 0.3, 1);
  }
  .pt-count {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: calc(0.5469rem * var(--orb-scale));
    font-weight: 600;
    line-height: 1;
    color: var(--solus-text-secondary);
  }
  .pt-sep {
    margin: 0 0.0313rem;
    color: var(--solus-text-tertiary);
  }
  .pt-arc-live {
    animation: ring-glow 2.6s ease-in-out infinite;
  }
  @keyframes ring-glow {
    0%, 100% { opacity: 0.85; }
    50% { opacity: 1; }
  }
  .pt-text {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: calc(0.4375rem * var(--orb-scale));
    min-width: 0;
  }
  .pt-count-text {
    flex-shrink: 0;
    font-size: calc(0.6563rem * var(--orb-scale));
    font-weight: 600;
    line-height: 1;
    color: var(--solus-text-secondary);
  }
  .pt-label {
    max-width: calc(9rem * var(--orb-scale));
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--orb-btn-font);
    font-weight: 500;
    color: var(--solus-text-secondary);
  }
  :global(.compact) .pt-fill,
  :global(.pill-mode) .pt-fill,
  :global(.compact) .pt-text,
  :global(.pill-mode) .pt-text {
    display: none;
  }
  /* Circle form: the dial fills the whole button so the ring reads as a border
     hugging the edge, rather than a small disc floating inside. */
  :global(.compact) .pt-dial,
  :global(.pill-mode) .pt-dial {
    display: block;
    position: absolute;
    inset: 0;
    width: auto;
    height: auto;
  }
  :global(.compact) .progress-toggle,
  :global(.pill-mode) .progress-toggle {
    width: var(--orb-btn-min);
    height: var(--orb-btn-min);
    padding: 0;
    gap: 0;
  }
  @keyframes pbi-flow {
    0% { background-position: -50% 0; }
    100% { background-position: 150% 0; }
  }
  .steps-pop {
    position: absolute;
    bottom: calc(100% + 0.5rem);
    left: 50%;
    transform: translateX(-50%);
    /* Scales with the orb (text size / pane width) but always stays within the
       viewport, so it works from the narrow pill window to wide editor mode. */
    width: min(calc(27rem * var(--orb-scale)), calc(100vw - 1.5rem));
    max-height: min(calc(20rem * var(--orb-scale)), 60vh);
    overflow-y: auto;
    pointer-events: auto;
    padding: calc(0.75rem * var(--orb-scale)) calc(0.9375rem * var(--orb-scale))
      calc(0.625rem * var(--orb-scale));
    border-radius: calc(1rem * var(--orb-scale));
    background: linear-gradient(
      180deg,
      color-mix(in srgb, var(--solus-popover-bg) 96%, transparent) 0%,
      color-mix(in srgb, var(--solus-popover-bg) 92%, transparent) 100%
    );
    backdrop-filter: blur(1.25rem) saturate(1.6);
    -webkit-backdrop-filter: blur(1.25rem) saturate(1.6);
    border: 0.0313rem solid var(--solus-popover-border);
    box-shadow:
      inset 0 0.0625rem 0 0 color-mix(in srgb, white 14%, transparent),
      0 0.25rem 0.875rem rgba(0, 0, 0, 0.1),
      0 0.75rem 1.75rem rgba(0, 0, 0, 0.12);
    animation: steps-in 0.22s cubic-bezier(0.16, 1, 0.3, 1);
    scrollbar-width: thin;
  }
  :global(.dark) .steps-pop {
    box-shadow:
      inset 0 0.0625rem 0 0 color-mix(in srgb, white 5%, transparent),
      0 0.25rem 0.875rem rgba(0, 0, 0, 0.3),
      0 0.75rem 1.75rem rgba(0, 0, 0, 0.3);
  }
  @keyframes steps-in {
    from { opacity: 0; transform: translateX(-50%) translateY(0.375rem); }
    to { opacity: 1; transform: translateX(-50%) translateY(0); }
  }
  .steps-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 0.5rem;
    padding-bottom: 0.375rem;
    border-bottom: 0.0313rem solid
      color-mix(in srgb, var(--solus-container-border) 30%, transparent);
  }
  .steps-head-label {
    font-size: calc(0.625rem * var(--orb-scale));
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--solus-text-tertiary);
  }
  .steps-head-count {
    font-size: calc(0.75rem * var(--orb-scale));
    font-weight: 600;
    color: var(--solus-text-secondary);
  }
  .steps-list {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .step-row {
    display: flex;
    gap: calc(0.625rem * var(--orb-scale));
    align-items: stretch;
  }
  .step-marker {
    display: flex;
    flex-direction: column;
    align-items: center;
    flex-shrink: 0;
    width: calc(0.6875rem * var(--orb-scale));
  }
  .step-dot {
    width: calc(0.5625rem * var(--orb-scale));
    height: calc(0.5625rem * var(--orb-scale));
    margin-top: 0.1875rem;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .step-dot-completed {
    background: color-mix(in srgb, var(--solus-accent) 80%, transparent);
  }
  .step-dot-in_progress {
    background: var(--solus-accent);
  }
  .step-dot-pending {
    background: transparent;
    border: 0.0938rem solid
      color-mix(in srgb, var(--solus-text-tertiary) 45%, transparent);
  }
  .step-dot-live {
    animation: step-pulse 2.6s ease-in-out infinite;
  }
  @keyframes step-pulse {
    0%, 100% {
      box-shadow: 0 0 0 0 color-mix(in srgb, var(--solus-accent) 40%, transparent);
    }
    50% {
      box-shadow: 0 0 0 0.1875rem
        color-mix(in srgb, var(--solus-accent) 0%, transparent);
    }
  }
  .step-line {
    flex: 1;
    width: 0.0938rem;
    min-height: 0.5rem;
    margin: 0.125rem 0;
    border-radius: 624.9375rem;
    background: color-mix(in srgb, var(--solus-text-tertiary) 18%, transparent);
  }
  .step-line-completed {
    background: color-mix(in srgb, var(--solus-accent) 32%, transparent);
  }
  .step-label {
    position: relative;
    flex: 1;
    min-width: 0;
    font-size: calc(0.8125rem * var(--orb-scale));
    line-height: 1.35;
    padding-bottom: calc(0.5625rem * var(--orb-scale));
    overflow: hidden;
    white-space: nowrap;
  }
  .step-row:last-child .step-label {
    padding-bottom: 0;
  }
  .sl-inner {
    display: inline-block;
    white-space: nowrap;
    transition: transform var(--marquee-dur, 0.3s) linear;
  }
  .step-label.is-truncated:hover .sl-inner {
    transform: translateX(calc(-1 * var(--scroll, 0px)));
  }
  .step-label.is-truncated::after {
    content: "…";
    position: absolute;
    top: 0;
    right: 0;
    padding: 0 0.125rem 0 0.875rem;
    line-height: 1.35;
    color: inherit;
    background: linear-gradient(
      90deg,
      transparent 0%,
      var(--solus-popover-bg) 55%
    );
    pointer-events: none;
    opacity: 1;
    transition: opacity 0.15s ease;
  }
  .step-label.is-truncated:hover::after {
    opacity: 0;
  }
  .step-label-completed {
    color: var(--solus-text-tertiary);
    opacity: 0.6;
  }
  .step-label-in_progress {
    color: var(--solus-accent);
    font-weight: 500;
    letter-spacing: -0.01em;
  }
  .step-label-pending {
    color: var(--solus-text-secondary);
    opacity: 0.8;
  }
</style>

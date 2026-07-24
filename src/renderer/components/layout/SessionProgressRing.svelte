<script lang="ts">
  import type { SessionProgress } from "../../../shared/types";
  import { tooltip } from "../../lib/tooltip";
  import { buildSessionProgressRing } from "./lib/session-progress-ring";

  interface Props {
    progress: SessionProgress;
  }

  let { progress }: Props = $props();
  const ring = $derived(buildSessionProgressRing(progress));
</script>

<span
  class="session-progress-ring"
  data-mode={ring.mode}
  role="img"
  aria-label={ring.label}
  use:tooltip={ring.label}
>
  <svg viewBox="0 0 20 20" aria-hidden="true">
    {#each ring.segments as segment, index (`${ring.mode}-${index}`)}
      <circle
        class="ring-segment ring-segment-{segment.state}"
        cx="10"
        cy="10"
        r="8"
        pathLength="100"
        stroke-dasharray={`${segment.length} ${100 - segment.length}`}
        stroke-dashoffset={-segment.start}
      />
    {/each}
  </svg>
</span>

<style>
  .session-progress-ring {
    display: inline-flex;
    flex-shrink: 0;
    width: 0.75rem;
    height: 0.75rem;
    color: var(--solus-text-tertiary);
  }

  svg {
    width: 100%;
    height: 100%;
    overflow: visible;
    transform: rotate(-90deg);
  }

  .ring-segment {
    fill: none;
    stroke-width: 2.25;
    stroke-linecap: round;
    transition:
      stroke 180ms ease,
      stroke-width 180ms ease,
      stroke-dasharray 180ms ease,
      stroke-dashoffset 180ms ease;
  }

  .ring-segment-pending {
    stroke: color-mix(in srgb, var(--solus-text-tertiary) 18%, transparent);
  }

  .ring-segment-completed {
    stroke: var(--solus-status-complete);
    opacity: 0.78;
  }

  .ring-segment-in_progress {
    stroke: var(--solus-status-running);
    stroke-width: 2.75;
  }

  [data-mode="continuous"] .ring-segment {
    stroke-linecap: butt;
  }

  [data-mode="continuous"] .ring-segment-in_progress {
    stroke-linecap: round;
  }

</style>

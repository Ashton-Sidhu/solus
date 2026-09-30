<script lang="ts">
  import { Square as StopIcon } from "@lucide/svelte";
  import ActivityRow from "./ActivityRow.svelte";
  import { Button } from "../ui/button";
  import type { BackgroundWait } from "./lib/activity-summary";

  /**
   * The session's `background` state, stated where the live row would be: at
   * the end of the last turn, beside the composer. The turn's own summary row
   * sits above a long answer, where nobody looks for what is still going on.
   *
   * It takes the live row's spinner and shimmer: the work is still running,
   * even though the turn is finished.
   *
   * Its Stop ends only the background work. The session Stop interrupts a turn,
   * and this turn already finished, so it would report a stop that never
   * happened to it.
   */
  interface Props {
    wait: BackgroundWait;
    /** Resolves once the host has taken the request; the row goes away when
     *  the tasks settle and the session leaves `background`. */
    onStop: () => Promise<void>;
  }
  let { wait, onStop }: Props = $props();

  let isStopping = $state(false);

  async function stop(): Promise<void> {
    isStopping = true;
    try {
      await onStop();
    } finally {
      isStopping = false;
    }
  }
</script>

{#snippet targetText()}{wait.target}{/snippet}

<!-- Stop sits on the rail, where a finished row keeps its step count, and takes
     the rail's own type: the row adds a control, not a new style. -->
{#snippet stopRail()}
  <Button
    variant="ghost"
    size="xs"
    class="size-5 rounded-full p-0 text-[color:color-mix(in_oklch,var(--failure)_70%,var(--foreground))] shadow-[shadow:0_0_0_0.03125rem_color-mix(in_oklch,var(--failure)_45%,transparent)] hover:bg-[color:color-mix(in_oklch,var(--failure)_10%,transparent)] hover:text-(color:--failure) dark:hover:bg-[color:color-mix(in_oklch,var(--failure)_14%,transparent)]"
    disabled={isStopping}
    onclick={stop}
    aria-label={isStopping ? "Stopping the background work" : "Stop the background work"}
    title={isStopping ? "Stopping…" : "Stop the background work"}
    data-testid="background-work-stop"
  >
    <!-- The composer's own Stop: a filled square in a thin failure ring, so it
         reads as Stop at a glance rather than as a rail figure. -->
    <StopIcon class="size-2" fill="currentColor" strokeWidth={0} aria-hidden="true" />
  </Button>
{/snippet}

<ActivityRow
  target={wait.target ? targetText : undefined}
  proseTarget
  rail={stopRail}
  testid="background-work-row"
>
  {#snippet glyph()}
    <span class="activity-spinner" aria-hidden="true"></span>
  {/snippet}
  {#snippet label()}<span class="activity-shimmer">{wait.label}</span>{/snippet}
</ActivityRow>

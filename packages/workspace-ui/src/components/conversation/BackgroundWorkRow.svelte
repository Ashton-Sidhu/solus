<script lang="ts">
  import ActivityRow from "./ActivityRow.svelte";
  import DotMatrix from "../ui/DotMatrix.svelte";
  import BackgroundStopButton from "./BackgroundStopButton.svelte";
  import type { BackgroundWait } from "./lib/activity-summary";
  import { revealTurnItem } from "./lib/reveal-in-transcript";
  import TaskStatusGlyph from "../session/TaskStatusGlyph.svelte";

  /**
   * The session's background work, stated where the live row would be: at
   * the end of the last turn, beside the composer. It shows in `background`,
   * and after a completed turn while work the agent did not mark (a dev
   * server, its Monitor) still runs (`showsBackgroundWork`). The turn's own summary row
   * sits above a long answer, where nobody looks for what is still going on.
   *
   * It takes the Running dot mark and the live row's shimmer: the work is
   * still running, even though the turn is finished.
   *
   * Its Stop ends only the background work. The session Stop interrupts a turn,
   * and this turn already finished, so it would report a stop that never
   * happened to it.
   *
   * A wait on other agent sessions is not work this session does: the session
   * is idle and takes a new message at once. So its one sentence says the
   * agents work in the background, the row takes the Delegating mark without
   * the shimmer, and it scrolls to the cards it waits on.
   * When one of those agents waits on you, the row takes the Input glyph its
   * card shows and scrolls to that card, where you answer it.
   */
  interface Props {
    wait: BackgroundWait;
    /** Resolves once the host has taken the request; the row goes away when
     *  the tasks settle. */
    onStop: () => Promise<void>;
  }
  let { wait, onStop }: Props = $props();

  let isStopping = $state(false);

  function showAgents(event: MouseEvent): void {
    if (wait.agentCardKey && event.currentTarget instanceof HTMLElement) {
      revealTurnItem(event.currentTarget, wait.agentCardKey);
    }
  }

  async function stop(): Promise<void> {
    isStopping = true;
    try {
      await onStop();
    } finally {
      isStopping = false;
    }
  }
</script>

{#snippet commandText()}{wait.command}{/snippet}

<!-- Stop sits on the rail, where a finished row keeps its step count, and takes
     the rail's own type: the row adds a control, not a new style. -->
{#snippet stopRail()}
  <BackgroundStopButton
    label={isStopping ? "Stopping the background work" : "Stop the background work"}
    title={isStopping ? "Stopping…" : "Stop the background work"}
    disabled={isStopping}
    onclick={stop}
    testid="background-work-stop"
  />
{/snippet}

<ActivityRow
  target={wait.command ? commandText : undefined}
  rail={stopRail}
  onActivate={wait.agentCardKey ? showAgents : undefined}
  testid="background-work-row"
>
  {#snippet glyph()}
    {#if wait.agentsNeedYou}
      <TaskStatusGlyph status="question" label={wait.label} size={15} showsWord={false} />
    {:else}
      <span class="flex items-center text-(--solus-status-working)"><DotMatrix mark={wait.agentCardKey ? "delegating" : "running"} /></span>
    {/if}
  {/snippet}
  {#snippet label()}<span class:activity-shimmer={!wait.agentCardKey}>{wait.label}</span>{/snippet}
</ActivityRow>

<script lang="ts">
  import { ChevronRight as OpenIcon, Pause as PauseIcon, Play as PlayIcon } from "@lucide/svelte";
  import type { AppCallView, AppScheduleLane, AppScheduleView } from "@solus/contracts/apps";
  import { Button } from "../../ui/button";
  import MarkdownAlert from "../../ui/MarkdownAlert.svelte";
  import CallDetail from "./CallDetail.svelte";
  import StateIcon from "./StateIcon.svelte";
  import { scheduleTriggerText } from "../lib/app-view";
  import { scheduleLastRunLine, scheduleNextRunText, scheduleRunSummary, scheduleRunTime } from "./lib/schedules";
  import { triggerClockText, triggerParts, upcomingRow } from "./lib/schedule-calendar";

  /**
   * The schedule the calendar selected, plain under it: its name and the
   * mutation it runs, Pause or Turn on, and Run now; its trigger as large
   * parts with the plain words of it; how its last run ended (an error
   * callout when it failed); its next runs, with no rules between them; and
   * its recent runs, each of which opens its call.
   */
  interface Props {
    serverId: string;
    appId: string;
    schedule: AppScheduleView;
    lane: AppScheduleLane | undefined;
    /** The newest first. */
    runs: AppCallView[];
    appStopped: boolean;
    isBusy: boolean;
    now: number;
    onRunNow: () => void;
    onToggleEnabled: () => void;
  }
  let { serverId, appId, schedule, lane, runs, appStopped, isBusy, now, onRunNow, onToggleEnabled }: Props = $props();

  const parts = $derived(triggerParts(schedule.trigger));
  const upcoming = $derived((lane?.upcoming ?? []).slice(0, 3));
  let openCallId = $state<string | null>(null);
</script>

<div class="flex min-w-0 gap-12 px-1 pt-1.5 @max-[48rem]/pane:flex-col @max-[48rem]/pane:gap-8" data-testid="app-schedule-detail">
  <div class="flex min-w-0 flex-1 flex-col gap-4">
    <div class="flex min-w-0 flex-wrap items-center justify-between gap-3">
      <div class="flex min-w-0 flex-col gap-0.75">
        <h3 class="m-0 truncate text-lg leading-5.5 font-semibold text-foreground">{schedule.name}</h3>
        <span class="truncate text-[13px] text-(--solus-text-tertiary)">Runs the mutation <span class="font-mono text-xs">{schedule.run}</span></span>
      </div>
      <div class="flex shrink-0 gap-2">
        <Button variant="outline" class="rounded-full" disabled={isBusy} onclick={onToggleEnabled} data-testid="app-schedule-toggle">
          {#if schedule.enabled}<PauseIcon /> Pause{:else}<PlayIcon /> Turn on{/if}
        </Button>
        <Button disabled={isBusy || appStopped} title={appStopped ? "Start the app to run a schedule" : undefined} onclick={onRunNow} data-testid="app-schedule-run-now">Run now</Button>
      </div>
    </div>

    <div class="flex min-w-0 flex-wrap items-end gap-x-5.5 gap-y-3">
      <div class="flex items-end gap-5.5" aria-label="Trigger" role="group">
        {#each parts as part, index (index)}
          <div class="flex flex-col items-center gap-1">
            <span class="font-mono text-[26px] leading-8 {part.isEvery ? 'text-(--solus-text-tertiary) opacity-60' : 'text-foreground'}">{part.value}</span>
            <span class="text-[11px] leading-3.5 text-(--solus-text-tertiary)">{part.label}</span>
          </div>
        {/each}
      </div>
      <span class="pb-4.5 pl-2.5 text-[15px] leading-4.5 text-(--solus-text-secondary)">{triggerClockText(scheduleTriggerText(schedule), schedule.trigger)}</span>
    </div>

    {#if schedule.lastOutcome === "failed"}
      <div class="text-[13px] leading-4.75 [--prose-ink-strong:var(--solus-text-primary)]" role="alert" data-testid="app-schedule-failure">
        <MarkdownAlert alertType="error">
          {#snippet content()}<span class="text-pretty">{scheduleLastRunLine(schedule, now)}</span>{/snippet}
        </MarkdownAlert>
      </div>
    {:else}
      <p class="m-0 text-[13px] leading-5 text-pretty text-(--solus-text-secondary)">{scheduleLastRunLine(schedule, now)}</p>
    {/if}

    <section class="flex min-w-0 flex-col pt-2" aria-label="Recent runs">
      <h4 class="m-0 pb-2 text-[13px] font-semibold text-foreground">Recent runs</h4>
      {#if runs.length === 0}
        <p class="m-0 text-[13px] text-(--solus-text-tertiary)">No run yet. Use Run now to test it.</p>
      {:else}
        <ul class="m-0 flex list-none flex-col p-0">
          {#each runs.slice(0, 10) as run (run.id)}
            {@const isOpen = openCallId === run.id}
            <li class="flex min-w-0 flex-col border-t border-[var(--hairline)]">
              <button
                type="button"
                class="flex min-h-9 min-w-0 cursor-pointer items-center gap-2.5 overflow-hidden rounded-md border-0 bg-transparent px-1 text-left text-[13px] transition-colors duration-150 hover:bg-[var(--wash-1)] focus-visible:bg-[var(--wash-2)] focus-visible:outline-none pointer-coarse:min-h-11"
                aria-expanded={isOpen}
                onclick={() => (openCallId = isOpen ? null : run.id)}
              >
                <OpenIcon size={12} class="shrink-0 text-(--solus-text-tertiary) transition-transform duration-150 motion-reduce:transition-none {isOpen ? 'rotate-90' : ''}" aria-hidden="true" />
                {#if run.outcome === "failed"}<StateIcon state="failed" size={14} />{/if}
                <span class="min-w-0 flex-1 truncate text-(--solus-text-secondary)">{scheduleRunSummary(run)}</span>
                <span class="shrink-0 text-(--solus-text-tertiary) tabular-nums">{scheduleRunTime(run, now)}</span>
              </button>
              {#if isOpen}
                <div class="mb-2 border-t border-[var(--hairline)]">
                  <CallDetail {serverId} {appId} callId={run.id} />
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  </div>

  <section class="flex w-55 shrink-0 flex-col @max-[48rem]/pane:w-full" aria-label="Next runs">
    <h4 class="m-0 pb-2 text-[13px] font-semibold text-foreground">Next runs</h4>
    {#if upcoming.length === 0}
      <p class="m-0 pt-2.5 text-sm text-(--solus-text-tertiary)">{scheduleNextRunText(schedule, appStopped, now)}</p>
    {:else}
      {#each upcoming as at (at)}
        {@const row = upcomingRow(at)}
        <div class="flex h-9 shrink-0 items-center justify-between text-sm">
          <span class="text-foreground">{row.day}</span>
          <span class="text-(--solus-text-tertiary) tabular-nums">{row.time}</span>
        </div>
      {/each}
      {#if appStopped}
        <p class="m-0 pt-2 text-xs text-(--solus-text-tertiary)">The app is stopped: a schedule does not run until the app starts.</p>
      {/if}
    {/if}
  </section>
</div>

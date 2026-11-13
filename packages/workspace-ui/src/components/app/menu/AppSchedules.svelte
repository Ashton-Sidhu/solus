<script lang="ts">
  import { untrack } from "svelte";
  import type { AppSummary } from "@solus/contracts/apps";
  import { appsStore } from "../../../contexts/apps/apps.store.svelte";
  import { toasts } from "../../../lib/toasts";
  import { Button } from "../../ui/button";
  import AppSectionState from "./AppSectionState.svelte";
  import { scheduleLastRunText, scheduleNextRunText, scheduleTriggerText } from "../lib/app-view";

  /** The schedules the active version declares: when each one runs, its last run, Pause or Turn on, and Run now. */
  let { serverId, app }: { serverId: string; app: AppSummary } = $props();

  $effect(() => {
    const hostId = serverId;
    const appId = app.id;
    untrack(() => void appsStore.schedules.load(hostId, appId));
  });
  const schedules = $derived(appsStore.schedules.get(serverId, app.id));

  /** The schedule a command runs for; its buttons wait. */
  let busyName = $state<string | null>(null);

  async function run(name: string, action: () => Promise<void>, failure: string) {
    if (busyName) return;
    busyName = name;
    try {
      await action();
    } catch (error) {
      toasts.error(failure, { description: error instanceof Error ? error.message : String(error) });
    } finally {
      busyName = null;
    }
  }
</script>

<AppSectionState
  count={schedules?.length}
  error={appsStore.schedules.errorFor(serverId, app.id)}
  empty="This app declares no schedule."
  onRetry={() => void appsStore.schedules.load(serverId, app.id)}
>
  <ul class="m-0 flex list-none flex-col gap-2 p-0" data-testid="app-schedules">
    {#each schedules ?? [] as schedule (schedule.name)}
      {@const lastRun = scheduleLastRunText(schedule)}
      <li class="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border/50 px-3 py-2">
        <div class="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span class="min-w-0 truncate font-medium">{schedule.name}</span>
          <span class="shrink-0 text-xs text-muted-foreground">{scheduleTriggerText(schedule)}</span>
          <span class="min-w-0 truncate text-xs text-muted-foreground">Runs <code class="font-mono">{schedule.run}</code></span>
        </div>
        <div class="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          <span>{scheduleNextRunText(schedule, app.stopped)}</span>
          {#if lastRun}
            <span class={schedule.lastOutcome === "failed" ? "text-destructive" : ""}>{lastRun}</span>
          {/if}
        </div>
        {#if schedule.lastOutcome === "failed" && schedule.lastError}
          <p class="m-0 text-xs text-destructive text-pretty">{schedule.lastError}</p>
        {/if}
        <div class="flex flex-wrap gap-2">
          <Button
            size="xs"
            variant="outline"
            disabled={busyName !== null}
            onclick={() => void run(schedule.name, () => appsStore.setScheduleEnabled(serverId, app.id, schedule.name, !schedule.enabled), "The schedule did not change")}
          >
            {schedule.enabled ? "Pause" : "Turn on"}
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={busyName !== null || app.stopped}
            onclick={() => void run(schedule.name, () => appsStore.runSchedule(serverId, app.id, schedule.name), "The schedule did not run")}
          >
            Run now
          </Button>
        </div>
      </li>
    {/each}
  </ul>
</AppSectionState>

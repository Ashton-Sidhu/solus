<script lang="ts">
  import { untrack } from "svelte";
  import type { AppSummary } from "@solus/contracts/apps";
  import { appsStore } from "../../../contexts/apps/apps.store.svelte";
  import { requestInputFocus } from "../../../lib/inputFocus";
  import { messageTimestampClock } from "../../../lib/shared-clock";
  import { toasts } from "../../../lib/toasts";
  import ManageSectionState from "./ManageSectionState.svelte";
  import ScheduleCalendar from "./ScheduleCalendar.svelte";
  import ScheduleDetail from "./ScheduleDetail.svelte";
  import { calendarEdges, sameEdges, shiftAnchor, type CalendarView } from "./lib/schedule-calendar";
  import { scheduleRuns } from "./lib/schedules";

  /**
   * The Schedules section (docs/plans/apps.md §8.1, §9.2): a calendar of the
   * schedules the active version declares, a week of days or a day of hours,
   * in the section's one card. The schedule it selects shows under it, plain:
   * its trigger, its last outcome, its next runs, and its recent runs.
   */
  let { serverId, app }: { serverId: string; app: AppSummary } = $props();

  let view = $state<CalendarView>("week");
  /** A time inside the calendar that shows: now, until the person moves it. */
  let anchor = $state(Date.now());
  const edges = $derived(calendarEdges(view, anchor));

  $effect(() => {
    const hostId = serverId;
    const appId = app.id;
    return untrack(() => {
      const releaseSchedules = appsStore.schedules.watch(hostId, appId);
      const releaseRuns = appsStore.scheduleCalls.watch(hostId, appId);
      return () => {
        releaseSchedules();
        releaseRuns();
      };
    });
  });
  $effect(() => {
    const hostId = serverId;
    const appId = app.id;
    const span = edges;
    return untrack(() => appsStore.scheduleCalendar.watch(hostId, appId, span));
  });
  const schedules = $derived(appsStore.schedules.get(serverId, app.id));
  const calls = $derived(appsStore.scheduleCalls.get(serverId, app.id) ?? []);
  // The answer for other edges is not this calendar's: the cells wait for the host.
  const calendar = $derived.by(() => {
    const answer = appsStore.scheduleCalendar.get(serverId, app.id);
    return answer && sameEdges(answer.edges, edges) ? answer : undefined;
  });

  // The column now and the next runs move with the clock, once a minute.
  let now = $state(Date.now());
  $effect(() => messageTimestampClock.subscribe((value) => (now = value)));

  let chosenName = $state<string | null>(null);
  const selected = $derived(
    (schedules ?? []).find((schedule) => schedule.name === chosenName) ??
      (schedules ?? []).find((schedule) => schedule.lastOutcome === "failed") ??
      schedules?.[0] ??
      null,
  );

  let isBusy = $state(false);

  async function run(action: () => Promise<void>, failure: string) {
    if (isBusy) return;
    isBusy = true;
    try {
      await action();
    } catch (error) {
      toasts.error(failure, { description: error instanceof Error ? error.message : String(error) });
    } finally {
      isBusy = false;
      requestInputFocus();
    }
  }
</script>

<ManageSectionState
  count={schedules?.length}
  error={appsStore.schedules.errorFor(serverId, app.id)}
  empty="This app declares no schedule."
  onRetry={() => void appsStore.schedules.load(serverId, app.id)}
>
  <div class="flex min-w-0 flex-col gap-5" data-testid="app-schedules">
    <ScheduleCalendar
      {view}
      {edges}
      {calendar}
      error={appsStore.scheduleCalendar.errorFor(serverId, app.id)}
      schedules={schedules ?? []}
      selectedName={selected?.name ?? null}
      {now}
      onSelect={(name) => (chosenName = name)}
      onView={(next) => (view = next)}
      onShift={(direction) => (anchor = shiftAnchor(view, anchor, direction))}
      onToday={() => (anchor = Date.now())}
      onRetry={() => void appsStore.scheduleCalendar.load(serverId, app.id, edges)}
    />

    {#if selected}
      <ScheduleDetail
        {serverId}
        appId={app.id}
        schedule={selected}
        lane={calendar?.lanes.find((lane) => lane.name === selected.name)}
        runs={scheduleRuns(calls, selected.name)}
        appStopped={app.stopped}
        {isBusy}
        {now}
        onRunNow={() => void run(() => appsStore.runSchedule(serverId, app.id, selected.name), "The schedule did not run")}
        onToggleEnabled={() => void run(() => appsStore.setScheduleEnabled(serverId, app.id, selected.name, !selected.enabled), "The schedule did not change")}
      />
    {/if}
  </div>
</ManageSectionState>

<script lang="ts">
  import { ChevronLeft as BackIcon, ChevronRight as ForwardIcon, X as FailedIcon } from "@lucide/svelte";
  import type { AppScheduleCalendar, AppScheduleView } from "@solus/contracts/apps";
  import { Button } from "../../ui/button";
  import { scheduleTriggerText } from "../lib/app-view";
  import { calendarCell, calendarCellLabel, calendarColumns, calendarTitle, clockTime, type CalendarView } from "./lib/schedule-calendar";

  /**
   * The calendar of the app's schedules: the one card of the section. One lane
   * for each schedule, one column for each day of the week or each hour of the
   * day. A cell says how many runs there were, or the time of its one run, a
   * failed run, the spans the trigger planned with no run, the column now, and
   * the next run.
   */
  interface Props {
    view: CalendarView;
    edges: number[];
    /** Undefined while the host has not answered for these edges. */
    calendar: AppScheduleCalendar | null | undefined;
    error: string | null;
    schedules: AppScheduleView[];
    selectedName: string | null;
    now: number;
    onSelect: (name: string) => void;
    onView: (view: CalendarView) => void;
    onShift: (direction: 1 | -1) => void;
    onToday: () => void;
    onRetry: () => void;
  }
  let { view, edges, calendar, error, schedules, selectedName, now, onSelect, onView, onShift, onToday, onRetry }: Props = $props();

  const columns = $derived(calendarColumns(view, edges, now));
  const isCurrent = $derived(edges[0] <= now && now < edges[edges.length - 1]);
  const lanes = $derived(new Map((calendar?.lanes ?? []).map((lane) => [lane.name, lane])));
  const nowColumn = $derived(columns.findIndex((column) => column.isNow));
  /** Where now is in its column, as a share of it. */
  const nowShare = $derived(nowColumn === -1 ? 0 : (now - columns[nowColumn].start) / (columns[nowColumn].end - columns[nowColumn].start));
</script>

<section
  class="flex min-w-0 flex-col overflow-hidden rounded-2xl border border-[var(--hairline-strong)] bg-background shadow-[0_1px_2px_rgb(0_0_0/0.03),0_6px_20px_rgb(0_0_0/0.04)] dark:shadow-none"
  aria-label="Calendar"
  data-testid="app-schedule-calendar"
>
  <div class="flex min-w-0 flex-wrap items-center gap-2.5 py-3.5 pr-4 pl-5">
    <h3 class="m-0 text-base leading-5 font-semibold text-foreground tabular-nums">{calendarTitle(view, edges)}</h3>
    <div class="flex gap-0.5">
      <Button variant="ghost" size="icon-sm" aria-label={view === "week" ? "The week before" : "The day before"} onclick={() => onShift(-1)}><BackIcon /></Button>
      <Button variant="ghost" size="icon-sm" aria-label={view === "week" ? "The week after" : "The day after"} onclick={() => onShift(1)}><ForwardIcon /></Button>
    </div>
    {#if !isCurrent}
      <Button variant="ghost" size="sm" onclick={onToday}>Today</Button>
    {/if}
    <span class="min-w-0 flex-1"></span>
    <span class="text-[13px] text-(--solus-text-tertiary) @max-[48rem]/pane:hidden">Runs only while the host is on</span>
    <div class="flex gap-0.5 rounded-[9px] bg-[var(--wash-3)] p-0.75" role="radiogroup" aria-label="Calendar view">
      {#each [{ value: "day", label: "Day" }, { value: "week", label: "Week" }] as const as option (option.value)}
        {@const isActive = view === option.value}
        <button
          type="button"
          role="radio"
          aria-checked={isActive}
          class="flex h-6.5 cursor-pointer items-center rounded-[7px] border-0 px-2.5 text-[13px] transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] pointer-coarse:h-9 {isActive
            ? 'bg-background font-medium text-foreground shadow-[0_1px_2px_rgb(0_0_0/0.06)]'
            : 'bg-transparent text-(--solus-text-tertiary) hover:text-foreground'}"
          onclick={() => onView(option.value)}>{option.label}</button
        >
      {/each}
    </div>
  </div>

  <div class="min-w-0 overflow-x-auto">
    <div class="flex min-w-0 flex-col {view === 'day' ? 'min-w-[56rem]' : 'min-w-[40rem]'}">
      <div class="flex h-10 shrink-0 border-t border-[var(--hairline)]">
        <div class="w-42.5 shrink-0 @max-[48rem]/pane:w-32"></div>
        {#each columns as column, index (column.start)}
          <div
            class="flex min-w-0 flex-1 basis-0 items-center overflow-hidden border-l border-[var(--hairline)] text-xs whitespace-nowrap {view === 'day' ? 'pl-1' : 'pl-2.5'} {column.isNow
              ? 'bg-[color-mix(in_srgb,var(--solus-accent)_6%,transparent)] text-(--solus-accent)'
              : 'text-(--solus-text-tertiary)'}"
          >
            {#if view === "week"}
              {column.label} <span class="ml-1 font-medium {column.isNow ? '' : 'text-foreground'}">{column.figure}</span>
            {:else if index % 3 === 0}
              <span class="tabular-nums">{column.figure}</span>
            {/if}
          </div>
        {/each}
      </div>

      {#if calendar === undefined}
        <div class="flex h-15 items-center border-t border-[var(--hairline)] px-5">
          {#if error}
            <span class="text-sm text-destructive" role="alert">{error}</span>
            <Button size="xs" variant="outline" class="ml-2" onclick={onRetry}>Try again</Button>
          {:else}
            <span class="text-sm text-muted-foreground" role="status" aria-busy="true">Loading the runs…</span>
          {/if}
        </div>
      {/if}

      {#each schedules as schedule (schedule.name)}
        {@const lane = lanes.get(schedule.name)}
        {@const isSelected = schedule.name === selectedName}
        <div class="flex h-15 shrink-0 border-t border-[var(--hairline)] {isSelected ? 'bg-[var(--wash-1)]' : ''}" data-testid="app-schedule-lane">
          <button
            type="button"
            class="flex w-42.5 min-w-0 shrink-0 cursor-pointer flex-col justify-center gap-0.5 overflow-hidden border-0 bg-transparent pr-2 pl-5 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] @max-[48rem]/pane:w-32 @max-[48rem]/pane:pl-3"
            aria-pressed={isSelected}
            onclick={() => onSelect(schedule.name)}
          >
            <span class="truncate text-sm leading-4.5 {schedule.enabled ? 'text-foreground' : 'text-(--solus-text-tertiary)'} {isSelected ? 'font-medium' : ''}">{schedule.name}</span>
            <span class="truncate text-xs text-(--solus-text-tertiary)">{scheduleTriggerText(schedule)}{schedule.enabled ? "" : " · paused"}</span>
          </button>
          {#each columns as column, index (column.start)}
            {@const span = lane?.spans[index]}
            {@const cell = span && lane ? calendarCell(span, column, lane, schedule.enabled, now) : { kind: "empty" as const }}
            <div
              class="relative flex min-w-0 flex-1 basis-0 items-center overflow-hidden border-l border-[var(--hairline)] {view === 'day' ? 'px-0.5' : 'px-1.5'} {cell.kind === 'paused' ? 'bg-[var(--wash-1)]' : ''} {column.isNow ? 'bg-[color-mix(in_srgb,var(--solus-accent)_4%,transparent)]' : ''}"
              title={calendarCellLabel(cell)}
            >
              {#if cell.kind === "time"}
                <span
                  class="mx-auto flex h-6.5 min-w-0 items-center gap-1.25 overflow-hidden rounded-full px-2.25 text-xs tabular-nums {cell.outcome === 'failed'
                    ? 'bg-[color-mix(in_oklch,var(--failure)_13%,transparent)] font-medium text-(--failure)'
                    : cell.outcome === 'running'
                      ? 'bg-[color-mix(in_oklch,var(--running)_14%,transparent)] text-[var(--running)]'
                      : 'bg-[color-mix(in_oklch,var(--success)_14%,transparent)] text-(--success)'}"
                >
                  {#if cell.outcome === "failed"}<FailedIcon size={10} strokeWidth={3} class="shrink-0" aria-hidden="true" />{/if}
                  <span class="truncate">{clockTime(cell.at)}</span>
                </span>
              {:else if cell.kind === "count"}
                <span class="flex h-6 min-w-0 flex-1 items-center gap-0.75">
                  <span
                    class="flex h-6 min-w-1 items-center gap-1 overflow-hidden pl-2 text-xs tabular-nums {cell.isNow ? 'rounded-l-[7px]' : 'rounded-[7px]'} {cell.failed > 0
                      ? 'bg-[color-mix(in_oklch,var(--failure)_12%,transparent)] text-(--failure)'
                      : 'bg-[color-mix(in_oklch,var(--success)_14%,transparent)] text-(--success)'}"
                    style:width="{Math.round(cell.fill * 100)}%"
                  >
                    {#if view === "week"}
                      <span class="truncate">{cell.runs}{#if cell.failed > 0}<span class="font-medium"> · {cell.failed} failed</span>{/if}</span>
                    {/if}
                  </span>
                  {#if cell.missedShare > 0}
                    <span class="flex h-6 min-w-0 flex-1 items-center justify-center overflow-hidden rounded-[7px] border border-dashed border-[var(--hairline-strongest)] text-[11px] whitespace-nowrap text-(--solus-text-tertiary)">
                      {#if view === "week"}no run{/if}
                    </span>
                  {/if}
                </span>
              {:else if cell.kind === "missed"}
                <span class="flex h-6 min-w-0 flex-1 items-center justify-center overflow-hidden rounded-[7px] border border-dashed border-[var(--hairline-strongest)] text-[11px] whitespace-nowrap text-(--solus-text-tertiary)">
                  {#if view === "week"}no run{/if}
                </span>
              {:else if cell.kind === "next"}
                <span class="mx-auto truncate text-xs text-(--solus-text-tertiary) tabular-nums">{view === "week" ? `${clockTime(cell.at)} →` : "→"}</span>
              {:else if cell.kind === "paused" && column.isNow}
                <span class="mx-auto truncate text-xs text-(--solus-text-tertiary)">Paused</span>
              {/if}
              {#if column.isNow && index === nowColumn}
                <span class="absolute top-1.5 bottom-1.5 w-0.5 rounded-[1px] bg-(--solus-accent)" style:left="{Math.round(nowShare * 100)}%" aria-hidden="true"></span>
              {/if}
            </div>
          {/each}
        </div>
      {/each}
    </div>
  </div>
  {#if calendar?.keptSince != null && calendar.keptSince > edges[0]}
    <p class="m-0 border-t border-[var(--hairline)] px-5 py-2.5 text-xs text-(--solus-text-tertiary)">
      The call log keeps the newest calls only: before {new Date(calendar.keptSince).toLocaleString()}, a day can show fewer runs than ran.
    </p>
  {/if}
</section>

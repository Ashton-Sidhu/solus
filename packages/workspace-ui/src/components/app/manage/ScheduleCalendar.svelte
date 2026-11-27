<script lang="ts">
  import { ChevronLeft as BackIcon, ChevronRight as ForwardIcon } from "@lucide/svelte";
  import type { AppScheduleCalendar, AppScheduleView } from "@solus/contracts/apps";
  import { Button } from "../../ui/button";
  import { scheduleTriggerText } from "../lib/app-view";
  import StateIcon from "./StateIcon.svelte";
  import { calendarCellLabel, calendarColumns, calendarLane, calendarTitle, clockTime, laterText, type CalendarView } from "./lib/schedule-calendar";

  /**
   * The calendar of the app's schedules: the one floating surface of the
   * section. One lane for each schedule, one column for each day of the week
   * or each hour of the day. A cell is quiet text: how many runs there were,
   * or the time of its one run with its mark, the mark of a day the host was
   * off, one "Paused since" over the paused span, and the next run. No cell
   * has a fill; hairlines are only between the lanes.
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
</script>

<section class="flex min-w-0 flex-col overflow-hidden rounded-2xl bg-background shadow-[shadow:var(--elev-lift)]" aria-label="Calendar" data-testid="app-schedule-calendar">
  <div class="flex min-w-0 flex-wrap items-center gap-2.5 px-5 pt-4 pb-3.5">
    <h3 class="m-0 text-base leading-5 font-semibold text-foreground tabular-nums">{calendarTitle(view, edges)}</h3>
    <div class="flex gap-0.5">
      <Button variant="ghost" size="icon-sm" aria-label={view === "week" ? "The week before" : "The day before"} onclick={() => onShift(-1)}><BackIcon /></Button>
      <Button variant="ghost" size="icon-sm" aria-label={view === "week" ? "The week after" : "The day after"} onclick={() => onShift(1)}><ForwardIcon /></Button>
    </div>
    <button
      type="button"
      class="cursor-pointer border-0 bg-transparent p-0 text-[13px] leading-4.5 text-(--solus-text-secondary) hover:text-foreground disabled:cursor-default disabled:hover:text-(--solus-text-secondary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] pointer-coarse:tap-area"
      disabled={isCurrent}
      onclick={onToday}>Today</button
    >
    <span class="min-w-0 flex-1"></span>
    <span class="text-[12.5px] leading-4 text-(--solus-text-tertiary) @max-[48rem]/pane:hidden">Runs only while the host is on</span>
    <span class="mx-1 h-3.5 w-px shrink-0 bg-[var(--hairline-strong)] @max-[48rem]/pane:hidden" aria-hidden="true"></span>
    <!-- The view, as words: the active one in ink, the other quiet. -->
    <div class="flex gap-2" role="radiogroup" aria-label="Calendar view">
      {#each [{ value: "day", label: "Day" }, { value: "week", label: "Week" }] as const as option (option.value)}
        {@const isActive = view === option.value}
        <button
          type="button"
          role="radio"
          aria-checked={isActive}
          class="cursor-pointer rounded-sm border-0 bg-transparent p-0 text-[13px] leading-4.5 transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] pointer-coarse:tap-area {isActive
            ? 'font-semibold text-foreground'
            : 'text-(--solus-text-tertiary) hover:text-foreground'}"
          onclick={() => onView(option.value)}>{option.label}</button
        >
      {/each}
    </div>
  </div>

  <div class="min-w-0 overflow-x-auto">
    <div class="flex min-w-0 flex-col {view === 'day' ? 'min-w-[56rem]' : 'min-w-[40rem]'}">
      <div class="flex shrink-0 items-end pb-2">
        <div class="w-45 shrink-0 @max-[48rem]/pane:w-32"></div>
        {#each columns as column, index (column.start)}
          <div class="flex min-w-0 flex-1 basis-0 flex-col items-center gap-0.5 overflow-hidden" aria-current={column.isNow ? "date" : undefined}>
            {#if view === "week"}
              <span class="text-[11px] leading-3.5 tracking-[0.04em] uppercase {column.isNow ? 'text-(--solus-accent)' : 'text-(--solus-text-tertiary)'}">{column.label}</span>
              {#if column.isNow}
                <span class="flex size-6.5 shrink-0 items-center justify-center rounded-full bg-(--solus-accent) text-sm leading-4.5 font-semibold text-white tabular-nums">{column.figure}</span>
              {:else}
                <span class="flex size-6.5 shrink-0 items-center justify-center text-[15px] leading-4.5 font-medium text-foreground tabular-nums">{column.figure}</span>
              {/if}
            {:else if index % 3 === 0 || column.isNow}
              <span class="text-[11px] leading-3.5 tabular-nums {column.isNow ? 'font-semibold text-(--solus-accent)' : 'text-(--solus-text-tertiary)'}">{column.figure}</span>
            {/if}
          </div>
        {/each}
        <div class="w-4 shrink-0"></div>
      </div>

      {#if calendar === undefined}
        <div class="flex h-14.5 items-center px-5 shadow-[inset_0_0.5px_0_var(--hairline)]">
          {#if error}
            <span class="text-[13px] text-(--solus-text-secondary)" role="alert">{error}</span>
            <Button size="xs" variant="outline" class="ml-2" onclick={onRetry}>Try again</Button>
          {:else}
            <span class="text-[13px] text-(--solus-text-tertiary)" role="status" aria-busy="true">Loading the runs…</span>
          {/if}
        </div>
      {/if}

      {#each schedules as schedule (schedule.name)}
        {@const isSelected = schedule.name === selectedName}
        <div class="flex h-14.5 shrink-0 items-center shadow-[inset_0_0.5px_0_var(--hairline)] {isSelected ? 'bg-[var(--wash-1)]' : ''}" data-testid="app-schedule-lane">
          <button
            type="button"
            class="flex h-full w-45 min-w-0 shrink-0 cursor-pointer flex-col justify-center gap-0.5 overflow-hidden border-0 bg-transparent pr-2 pl-5 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] @max-[48rem]/pane:w-32 @max-[48rem]/pane:pl-3"
            aria-pressed={isSelected}
            onclick={() => onSelect(schedule.name)}
          >
            <span class="truncate text-[13.5px] leading-4.5 {schedule.enabled ? 'text-foreground' : 'text-(--solus-text-tertiary)'} {isSelected ? 'font-semibold' : ''}">{schedule.name}</span>
            <span class="truncate text-xs leading-4 text-(--solus-text-tertiary) {schedule.enabled ? '' : 'opacity-70'}">{scheduleTriggerText(schedule)}</span>
          </button>
          {#if calendar !== undefined}
            {#each calendarLane(lanes.get(schedule.name), columns, schedule, view, now) as piece (piece.start)}
              {@const cell = piece.cell}
              <div class="flex min-w-0 basis-0 items-center justify-center gap-1.25 overflow-hidden px-0.5 whitespace-nowrap" style:flex-grow={piece.columns} title={calendarCellLabel(cell, piece.since)}>
                {#if cell.kind === "time"}
                  <StateIcon state={cell.outcome} size={14} />
                  {#if view === "week"}<span class="truncate text-[13px] leading-4.5 text-foreground tabular-nums">{clockTime(cell.at)}</span>{/if}
                {:else if cell.kind === "count"}
                  {#if cell.isShort}
                    <!-- The host was off for a part of the span: the mark of an offline host, the count quiet. -->
                    <StateIcon state="offline" size={12} />
                    {#if view === "week"}<span class="text-xs leading-4 text-(--solus-text-tertiary) tabular-nums">{cell.runs}</span>{/if}
                  {:else}
                    {#if cell.failed > 0}<StateIcon state="failed" size={14} />{/if}
                    {#if view === "week"}
                      <span class="flex items-baseline gap-0.75">
                        <span class="text-sm leading-4.5 text-foreground tabular-nums {cell.isNow ? 'font-semibold' : ''}">{cell.runs}</span>
                        {#if piece.hasUnit}<span class="text-[11px] leading-3.5 text-(--solus-text-tertiary)">runs</span>{/if}
                      </span>
                    {:else}
                      <span class="text-[11px] leading-3.5 text-foreground tabular-nums {cell.isNow ? 'font-semibold' : ''}">{cell.runs}</span>
                    {/if}
                  {/if}
                {:else if cell.kind === "missed"}
                  <StateIcon state="offline" size={12} />
                  {#if view === "week"}<span class="text-xs leading-4 text-(--solus-text-tertiary) tabular-nums">0</span>{/if}
                {:else if cell.kind === "next"}
                  <span class="truncate text-xs leading-4 text-(--solus-text-tertiary) tabular-nums">{view === "week" ? `${clockTime(cell.at)} →` : "→"}</span>
                {:else if cell.kind === "later"}
                  <span class="truncate text-xs leading-4 text-(--solus-text-tertiary) tabular-nums">{view === "week" ? `${laterText(cell.at, now)} →` : "→"}</span>
                {:else if cell.kind === "paused"}
                  <StateIcon state="idle" size={15} class="opacity-70" />
                  {#if view === "week" || piece.columns > 2}<span class="truncate text-[12.5px] leading-4 text-(--solus-text-tertiary) opacity-70">{calendarCellLabel(cell, piece.since)}</span>{/if}
                {/if}
              </div>
            {/each}
          {/if}
          <div class="w-4 shrink-0"></div>
        </div>
      {/each}
    </div>
  </div>
  {#if calendar?.keptSince != null && calendar.keptSince > edges[0]}
    <p class="m-0 px-5 py-2.5 text-xs text-(--solus-text-tertiary) shadow-[inset_0_0.5px_0_var(--hairline)]">
      The call log keeps the newest calls only: before {new Date(calendar.keptSince).toLocaleString()}, a day can show fewer runs than ran.
    </p>
  {/if}
</section>

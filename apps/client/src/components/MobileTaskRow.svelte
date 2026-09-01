<script lang="ts">
  import { Sun as SunIcon } from "@lucide/svelte";
  import ReviewGuideGlyph from "@solus/workspace-ui/components/review/ReviewGuideGlyph.svelte";
  import ProjectFavicon from "@solus/workspace-ui/components/ui/ProjectFavicon.svelte";
  import {
    formatElapsed,
    type SidebarTask,
  } from "@solus/workspace-ui/components/session/lib/task-list";
  import MobileStateGlyph from "./MobileStateGlyph.svelte";
  import {
    MOBILE_STATE_INK,
    MOBILE_STATE_TILE_BG,
    MOBILE_STATE_TILE_INK,
    mobileRowTimestamp,
    mobileSessionCount,
    mobileSnoozeWake,
    mobileTaskState,
  } from "../lib/mobile-task-row";

  interface Props {
    task: SidebarTask;
    /** True while the session on screen belongs to this task. */
    active: boolean;
    sessionCount: number;
    reviewStatus: "generating" | "ready" | null;
    /** Ticking second, passed in so one clock drives the whole list. */
    now: number;
    onOpen: () => void;
    /** Only snoozed rows offer it — the row's visible twin of the swipe. */
    onWake?: () => void;
  }
  let { task, active, sessionCount, reviewStatus, now, onOpen, onWake }: Props = $props();

  const state = $derived(mobileTaskState(task));
  const isRunning = $derived(task.lifecycle === "active" && task.status === "running");
  const elapsed = $derived(
    isRunning && task.runStartedAt ? formatElapsed(now - task.runStartedAt) : "",
  );
  const wake = $derived(
    task.lifecycle === "snoozed" ? mobileSnoozeWake(task.snoozedUntil, now) : "",
  );
  const timestamp = $derived(
    isRunning || task.lifecycle === "snoozed"
      ? ""
      : mobileRowTimestamp(task.activityAt, now),
  );
  const runs = $derived(mobileSessionCount(sessionCount));
  // A completed row keeps its title, at a lower ink: the work is done, not gone.
  const dimmed = $derived(task.lifecycle === "snoozed");
</script>

<!--
  62px, one task. State is the leading glyph and its colour — the same
  silhouette the desktop sidebar draws in its margin, so a reader learns one
  vocabulary and not two. Everything else — title, project, run count — sits on
  the second line where it cannot push the title into an ellipsis.
-->
<button
  type="button"
  class="flex h-[3.875rem] w-full cursor-pointer items-center gap-[0.6875rem] rounded-2xl border-0 px-3 text-left [-webkit-tap-highlight-color:transparent] {active
    ? 'bg-(--wash-2)'
    : 'bg-transparent active:bg-(--wash-1)'}"
  class:opacity-55={dimmed}
  aria-label={state.label ? `${task.title} — ${state.label}` : task.title}
  onclick={onOpen}
>
  <!-- The row names its state in words on the button itself, so the tile is
       decoration to a screen reader rather than a second announcement. -->
  <span
    class="flex size-7 shrink-0 items-center justify-center rounded-lg"
    style="background:{MOBILE_STATE_TILE_BG[state.tone]};color:{MOBILE_STATE_TILE_INK[state.tone]}"
    aria-hidden="true"
  >
    <MobileStateGlyph glyph={state.glyph} />
  </span>

  <span class="flex min-w-0 flex-1 flex-col">
    <span
      class="truncate text-sm font-medium tracking-[-0.005em] {task.lifecycle === 'completed'
        ? 'text-(--muted-foreground)'
        : 'text-(--solus-text-primary)'}"
    >{task.title}</span>
    <span class="mt-[0.1875rem] flex min-w-0 items-center gap-1.5 text-xs">
      <!-- Where the work lives leads the line, as it does on the desktop row:
           the mark identifies the project faster than its name, and the name
           truncates before any of the facts that follow it. A running or
           snoozed row used to spend this slot on its clock and say nothing at
           all about its project. -->
      {#if task.projectLabel}
        <ProjectFavicon
          projectRoot={task.projectKey}
          serverId={task.serverId}
          class="size-3.5 shrink-0"
        />
        <span class="min-w-0 truncate text-(--muted-foreground)">{task.projectLabel}</span>
      {/if}
      {#if elapsed}
        {#if task.projectLabel}
          <span class="shrink-0 text-(--muted-foreground) opacity-40">·</span>
        {/if}
        <span class="shrink-0 font-mono tabular-nums" style="color:{MOBILE_STATE_INK.running}"
          >{elapsed}</span
        >
      {:else if wake}
        {#if task.projectLabel}
          <span class="shrink-0 text-(--muted-foreground) opacity-40">·</span>
        {/if}
        <span class="min-w-0 truncate text-(--muted-foreground)">{wake}</span>
      {/if}
      {#if runs}
        <span class="text-(--muted-foreground) opacity-40">·</span>
        <span class="shrink-0 text-(--muted-foreground)">{runs}</span>
      {/if}
      {#if timestamp}
        <span class="shrink-0 font-mono text-(--muted-foreground)">{timestamp}</span>
      {/if}
    </span>
  </span>

  {#if reviewStatus}
    <!-- Generating and ready are one object at two stages: the outline guide
         breathes while it is written, then fills once it can be read. -->
    <span
      class="flex shrink-0 items-center {reviewStatus === 'ready'
        ? 'text-(--solus-status-complete)'
        : 'text-chart-5'}"
      aria-label={reviewStatus === "ready" ? "Review guide ready" : "Generating review guide"}
    >
      <ReviewGuideGlyph
        size={15}
        weight={reviewStatus === "ready" ? "fill" : undefined}
        class={reviewStatus === "ready"
          ? ""
          : "animate-pulse [animation-duration:1.4s] motion-reduce:animate-none"}
      />
    </span>
  {/if}

  {#if onWake}
    <span
      role="button"
      tabindex="0"
      class="flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-full bg-(--solus-accent-light) px-3 text-xs font-medium text-(--solus-accent) [-webkit-tap-highlight-color:transparent]"
      aria-label="Wake {task.title} now"
      onclick={(e) => {
        e.stopPropagation();
        onWake?.();
      }}
      onkeydown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        e.stopPropagation();
        onWake?.();
      }}
    >
      <SunIcon size={14} />Wake
    </span>
  {/if}
</button>

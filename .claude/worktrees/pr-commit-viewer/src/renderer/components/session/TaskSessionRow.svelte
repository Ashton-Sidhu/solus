<script lang="ts">
  import {
    BookOpenTextIcon,
    CheckIcon,
    CircleNotchIcon,
    GlobeIcon,
    LaptopIcon,
    MoonIcon,
    XIcon,
  } from "phosphor-svelte";
  import type { SidebarSessionChild } from "../../contexts/workspace/session-sidebar.store.svelte";
  import { attentionLabel } from "../../lib/sessionUtils";
  import { liveActivityClock } from "../../lib/shared-clock";
  import { serversStore } from "../../contexts/connections/servers.store.svelte";
  import SessionNameInput from "./SessionNameInput.svelte";
  import TaskStatusGlyph from "./TaskStatusGlyph.svelte";
  import UnreadDot from "./UnreadDot.svelte";
  import {
    formatElapsed,
    hasGlyph,
    taskStatusFor,
  } from "./lib/task-list";

  interface Props {
    session: SidebarSessionChild;
    selected: boolean;
    /** The parent task holds the session you are reading, so this cluster leads
     *  in full ink; sessions elsewhere rest at the secondary tone. */
    onPath: boolean;
    /** True while this row's name is being edited in place. */
    renaming: boolean;
    /** This row is the selected session, or sits above it under the same task.
     *  The accent spine is the *path* to what you are reading, not a mark on one
     *  row, so every row it passes draws its own segment of it. */
    leadsToSelection: boolean;
    onSelect: () => void;
    onRename: (next: string) => void;
    onRenameCancel: () => void;
    onMore: (event: MouseEvent | PointerEvent) => void;
    onSnooze?: (anchor: HTMLElement) => void;
    onComplete?: () => void;
    onClose: () => void;
  }
  let {
    session,
    selected,
    onPath,
    renaming,
    leadsToSelection,
    onSelect,
    onRename,
    onRenameCancel,
    onMore,
    onSnooze,
    onComplete,
    onClose,
  }: Props = $props();

  const status = $derived(taskStatusFor(session.attention));
  const titleIsEmphasized = $derived(selected || hasGlyph(status));
  const titleLeads = $derived(onPath || titleIsEmphasized);
  // `unread` maps to an idle status, so this never competes with a glyph or the
  // elapsed readout — but state it directly rather than leaning on the chain.
  const showsUnreadDot = $derived(
    session.attention === "unread" && status === "idle",
  );
  const runStartedAt = $derived(session.runStartedAt);

  let now = $state(Date.now());
  $effect(() => {
    if (status !== "running") return;
    return liveActivityClock.subscribe((value) => {
      now = value;
    });
  });
  const elapsed = $derived(
    status === "running" && runStartedAt
      ? formatElapsed(now - runStartedAt)
      : "",
  );

  const showsMargin = $derived(
    session.reviewGuideStatus === "generating" ||
      session.reviewGuideStatus === "ready" ||
      hasGlyph(status) ||
      !!elapsed ||
      showsUnreadDot,
  );

  // Which machine the session runs on. Unlike the task row this is never
  // omitted: a subtask list mixes hosts freely, so "here" has to be stated
  // rather than inferred from the absence of a mark.
  const host = $derived(serversStore.hostFor(session.serverId));
  const isRemote = $derived(!!host && !host.local);

  const iconButton =
    "flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-[color,background] duration-[120ms] hover:bg-[color-mix(in_oklch,var(--foreground)_7%,transparent)] hover:text-foreground";
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  let suppressNextClick = false;
  function startLongPress(event: PointerEvent) {
    if (event.pointerType !== "touch") return;
    longPressTimer = setTimeout(() => {
      suppressNextClick = true;
      onMore(event);
    }, 500);
  }
  function cancelLongPress() {
    if (longPressTimer) clearTimeout(longPressTimer);
    longPressTimer = null;
  }
</script>

<!-- One step in from the task title's spine, with no plate of its own: the
     connector carries the hierarchy, so nothing here needs a box. -->
<div
  class="group/session relative -mr-1 flex h-[2.875rem] cursor-pointer items-center gap-[0.5625rem] rounded-lg pr-2 transition-[background] duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring pl-8 hover:bg-[color-mix(in_oklch,var(--foreground)_3.5%,transparent)]"
  role="treeitem"
  tabindex="-1"
  data-tab-id={session.tabId}
  data-task-id={session.taskId}
  aria-selected={selected}
  aria-label={session.isSubtask ? `Subtask: ${session.label}` : session.label}
  title={session.snoozeReminder
    ? `Snooze reminder: ${session.snoozeReminder}`
    : undefined}
  onclick={(event) => {
    if (suppressNextClick) {
      suppressNextClick = false;
      event.preventDefault();
      return;
    }
    onSelect();
  }}
  oncontextmenu={onMore}
  onpointerdown={startLongPress}
  onpointerup={cancelLongPress}
  onpointercancel={cancelLongPress}
  onpointermove={cancelLongPress}
  onkeydown={(event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect();
    }
  }}
>
  <!-- The elbow off the spine. It runs into the *title*, not the row's midpoint:
       the line below is a detail about the row, and a connector aimed between
       the two would be aimed at neither. 0.875rem is where the title line
       centres at this row height — `TaskRow`'s spine stops on the same figure so
       it closes on the last child's elbow instead of trailing past it.

       Selection is spent on the connector rather than on a plate: the spine
       runs terracotta from the task down to the row you are reading, which
       turns its own elbow the same colour. Marking the path rather than the row
       is what makes a deep list answer "where am I?" at a glance. Because the
       row keeps no wash of its own, the ordinary hover fill still reads on it —
       which a selected plate would have swallowed. -->
  {#if leadsToSelection}
    <!-- Above the selected row the path is passing through, so its segment
         bridges the 3px gap to the next one. On the selected row the path has
         arrived: it stops on its own elbow — 0.875rem plus the elbow's own
         1.5px, so the two meet as a corner — rather than carrying on to the
         row's bottom edge and branching into nothing. This is the same rule
         that stops the grey spine on the last child's elbow; an accent that
         ran past it would be the one line in the tree pointing at no row. -->
    <span
      class="pointer-events-none absolute top-0 left-2.5 w-[0.09375rem] rounded-[0.0625rem] bg-primary {selected
        ? 'h-[0.96875rem]'
        : '-bottom-[0.1875rem]'}"
      aria-hidden="true"
    ></span>
  {/if}
  <span
    class="pointer-events-none absolute top-[0.875rem] left-2.5 w-[0.875rem] {selected
      ? 'h-[0.09375rem] rounded-[0.0625rem] bg-primary'
      : 'h-px bg-[color-mix(in_oklch,var(--foreground)_14%,transparent)]'}"
    aria-hidden="true"
  ></span>

  <span class="flex min-w-0 flex-1 flex-col">
    <!-- The title and everything that reports on it share one line box. The row
         is two lines tall, so marks centred against the row would hang between
         the title they speak for and the branch line below, pointing at
         neither — and sitting *in* the title's line is what keeps them on it
         without a hand-tuned offset to drift out of date. The box is pinned to
         the title's own line height so a taller mark (a 24px action button)
         overflows it symmetrically instead of pushing the branch line down —
         the rename wash included, which is why the height holds while renaming
         rather than being handed to the input. -->
    <span class="flex h-[1.125rem] items-center gap-[0.5625rem]">
      {#if renaming}
        <SessionNameInput
          value={session.label}
          class="text-[0.8125rem] {titleIsEmphasized
            ? 'font-medium '
            : ''}"
          onCommit={onRename}
          onCancel={onRenameCancel}
        />
      {:else}
        <span
          class="min-w-0 flex-1 overflow-hidden text-[0.8125rem] leading-[1.125rem] text-ellipsis whitespace-nowrap transition-colors duration-150 {titleIsEmphasized
            ? 'font-medium '
            : ''} {titleLeads
            ? 'text-foreground'
            : 'text-(--solus-text-secondary)'}">{session.label}</span
        >
      {/if}

      <!-- The margin never dims and never swaps out on hover. It is dropped
           rather than left empty: an empty flex child still spends the line's
           gap, which the title would pay for in truncation. -->
      {#if showsMargin}
        <span class="flex shrink-0 items-center gap-[0.5625rem]">
          {#if session.reviewGuideStatus === "generating"}
            <span
              class="flex shrink-0 items-center text-(--solus-status-running-icon)"
              role="img"
              aria-label="Generating review guide"
              title="Generating review guide"
            >
              <CircleNotchIcon
                size={13}
                class="animate-spin [animation-duration:0.9s] motion-reduce:animate-none"
              />
            </span>
          {:else if session.reviewGuideStatus === "ready"}
            <span
              class="flex shrink-0 items-center text-(--solus-art-positive)"
              role="img"
              aria-label="Review guide ready"
              title="Review guide ready"
            >
              <BookOpenTextIcon size={13} weight="fill" />
            </span>
          {/if}

          <!-- Match the task row's state column while preserving the child
               row's slightly smaller glyph sizes. -->
          <span
            class="flex min-w-[0.875rem] shrink-0 items-center justify-center"
          >
            {#if hasGlyph(status)}
              <TaskStatusGlyph
                {status}
                size={13}
                label={attentionLabel(session.attention)}
              />
            {:else if elapsed}
              <!-- The clock on the current session joins its elbow in terracotta,
                   so the row you are reading states its own state in one
                   colour. -->
              <span
                class="shrink-0 font-mono text-xs tabular-nums {selected
                  ? 'text-[color-mix(in_oklch,var(--primary)_68%,var(--foreground))]'
                  : 'text-[color-mix(in_oklch,var(--foreground)_64%,transparent)]'}">{elapsed}</span
              >
            {:else if showsUnreadDot}
              <UnreadDot size={6} />
            {/if}
          </span>
        </span>
      {/if}

      <!-- Durable children keep their workflow actions after their tab closes.
           Closing is available only for a mounted session. -->
      {#if session.tabId || session.taskId}
        <span
          class="-mr-1 hidden shrink-0 items-center gap-px group-hover/session:flex"
        >
          <!-- Same three actions, same order, as the task row above it. -->
          <button
            class={iconButton}
            title="Snooze"
            aria-label="Snooze subtask"
            disabled={!onSnooze}
            onclick={(event) => {
              event.stopPropagation();
              onSnooze?.(event.currentTarget);
            }}
          >
            <MoonIcon size={13} />
          </button>
          {#if onComplete}
            <button
              class={iconButton}
              title="Mark subtask completed"
              aria-label="Mark subtask completed"
              onclick={(event) => {
                event.stopPropagation();
                onComplete();
              }}
            >
              <CheckIcon size={14} weight="bold" />
            </button>
          {/if}
          {#if session.tabId || session.dismissalKey}
            <button
              class={iconButton}
              title={session.taskId ? "Remove from sidebar" : "Close session"}
              aria-label={session.taskId ? "Remove task from sidebar" : "Close session"}
              onclick={(event) => {
                event.stopPropagation();
                onClose();
              }}
            >
              <XIcon size={13} weight="bold" />
            </button>
          {/if}
        </span>
      {/if}
    </span>

    <!-- Where this session's work actually lives. The task above already names
         the project, so what is left to say is which worktree — and which
         machine, because a subtask can be running somewhere its siblings are
         not. -->
    <span
      class="mt-1 flex max-w-full items-center gap-[0.375rem] text-xs text-[color-mix(in_oklch,var(--foreground)_64%,transparent)]"
    >
      {#if session.branchName}
        <span class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
          >{session.branchName}</span
        >
        <span class="shrink-0">·</span>
      {/if}
      {#if isRemote}
        <GlobeIcon size={11} class="shrink-0" aria-label={host?.label} />
      {:else}
        <LaptopIcon size={11} class="shrink-0" aria-label="This machine" />
      {/if}
    </span>
  </span>
</div>

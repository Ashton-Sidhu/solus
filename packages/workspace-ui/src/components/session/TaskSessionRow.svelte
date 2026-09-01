<script lang="ts">
  import {
    Check as CheckIcon,
    Laptop as LaptopIcon,
    Moon as MoonIcon,
    LoaderCircle as SpinnerGapIcon,
    X as XIcon,
  } from "@lucide/svelte";
  import type { SidebarSessionChild } from "../../contexts/workspace/session-sidebar.store.svelte";
  import { attentionLabel } from "../../lib/sessionUtils";
  import { shouldActivateRenameableRow } from "../../lib/rename-input";
  import { worktreeDisplayName } from "../../lib/git-context";
  import { liveActivityClock } from "../../lib/shared-clock";
  import { serversStore } from "../../contexts/connections/servers.store.svelte";
  import HostOperatingSystemIcon from "../servers/HostOperatingSystemIcon.svelte";
  import SessionNameInput from "./SessionNameInput.svelte";
  import ReviewGuideGlyph from "../review/ReviewGuideGlyph.svelte";
  import TaskStatusGlyph from "./TaskStatusGlyph.svelte";
  import UnreadDot from "./UnreadDot.svelte";
  import SessionSidebarTooltip from "./SessionSidebarTooltip.svelte";
  import * as TooltipUI from "../ui/tooltip";
  import {
    resolveSidebarRowMark,
    shouldEmphasizeTitle,
    shouldRecedeRow,
    taskStatusFor,
  } from "./lib/task-list";

  interface Props {
    session: SidebarSessionChild;
    projectLabel: string;
    selected: boolean;
    /** True while this row's name is being edited in place. */
    renaming: boolean;
    /** This row is the selected session, or sits above it under the same task.
     *  The accent spine is the *path* to what you are reading, not a mark on one
     *  row, so every row it passes draws its own segment of it. */
    leadsToSelection: boolean;
    onSelect: () => void;
    /** Rename this row where it sits, the same edit the context menu opens. */
    onStartRename: () => void;
    onRename: (next: string) => void;
    onRenameCancel: () => void;
    onMore: (event: MouseEvent | PointerEvent) => void;
    onSnooze?: (anchor: HTMLElement) => void;
    onComplete?: () => void;
    onClose: () => void;
  }
  let {
    session,
    projectLabel,
    selected,
    renaming,
    leadsToSelection,
    onSelect,
    onStartRename,
    onRename,
    onRenameCancel,
    onMore,
    onSnooze,
    onComplete,
    onClose,
  }: Props = $props();

  const status = $derived(taskStatusFor(session.attention));
  // Only the session you are reading — and any session asking for a person —
  // leads in weight. Its siblings rest at the secondary tone even while the task
  // above them holds the selection, so a long subtask list points at one row
  // instead of reading as a block of equally live work.
  const titleIsEmphasized = $derived(
    shouldEmphasizeTitle(status, session.unread, selected),
  );
  // Ink belongs to the row, not the title: a quiet session steps back as one
  // object so its siblings stop reading as a block of equally live work. A
  // session has no snooze of its own, so it can never be the row returning
  // from one.
  const recedes = $derived(
    shouldRecedeRow(status, session.unread, false, selected),
  );
  const branchLabel = $derived(
    session.branchName ? worktreeDisplayName(session.branchName) : "",
  );

  let now = $state(Date.now());
  $effect(() => {
    if (status !== "running") return;
    return liveActivityClock.subscribe((value) => {
      now = value;
    });
  });

  // The same ladder the task row spends, one level down: a session row is a
  // leaf, so it always has a single datable turn and never needs the spinner
  // fallback, and neither shelf's clock can reach it.
  const mark = $derived(
    resolveSidebarRowMark({
      status,
      unread: session.unread,
      woke: false,
      reviewGuide: session.reviewGuideStatus,
      lifecycle: "active",
      runStartedAt: session.runStartedAt,
      manyRunning: false,
      completedAt: 0,
      snoozedUntil: 0,
      now,
    }),
  );

  // Which machine the session runs on. Unlike the task row this is never
  // omitted: a subtask list mixes hosts freely, so "here" has to be stated
  // rather than inferred from the absence of a mark.
  const host = $derived(serversStore.hostFor(session.serverId));
  const isRemote = $derived(!!host && !host.local);
  // A host Solus no longer has a saved entry for names no operating system;
  // the icon falls back to a globe in that case.
  const remoteOs = $derived(host && "os" in host ? host.os : undefined);
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
<TooltipUI.Root>
  <TooltipUI.Trigger>
    {#snippet child({ props: tooltipProps })}
<div
  {...tooltipProps}
  class="group/session relative -mx-2 flex h-[2.875rem] cursor-pointer items-center gap-[0.5625rem] rounded-lg pr-2 pl-11 @max-[15rem]:gap-1.5 @max-[15rem]:pl-[2.375rem] transition-[background,color] duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring hover:bg-[color-mix(in_oklch,var(--foreground)_3.5%,transparent)] {recedes
    ? 'text-[color-mix(in_oklch,var(--solus-text-secondary)_75%,transparent)] hover:text-foreground'
    : 'text-foreground'}"
  role="treeitem"
  tabindex="-1"
  data-tab-id={session.tabId}
  data-task-id={session.taskId}
  aria-selected={selected}
  aria-label={session.isSubtask ? `Subtask: ${session.label}` : session.label}
  onclick={(event) => {
    if (suppressNextClick) {
      suppressNextClick = false;
      event.preventDefault();
      return;
    }
    if (!shouldActivateRenameableRow(event.detail)) return;
    onSelect();
  }}
  ondblclick={onStartRename}
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
       the other line is a detail about the row, and a connector aimed between
       the two would be aimed at neither. The title now sits on the row's second
       line, matching the task row above it, so the elbow drops with it: 2rem is
       where that line centres at this row height (5px of slack, the 16px
       context line, the 2px gap, then half of the 18px title box).
       `TaskRow`'s spine is derived from the same figure so it closes on the
       last child's elbow instead of trailing past it — the two are one
       measurement and have to move together.

       Selection is spent on the connector rather than on a plate: the spine
       runs terracotta from the task down to the row you are reading, which
       turns its own elbow the same colour. The row's negative margin widens its
       hover plate, so the connector offsets by the same 0.5rem to stay on the
       parent spine. Marking the path rather than the row
       is what makes a deep list answer "where am I?" at a glance. Because the
       row keeps no wash of its own, the ordinary hover fill still reads on it —
       which a selected plate would have swallowed. -->
  {#if leadsToSelection}
    <!-- Above the selected row the path is passing through, so its segment
         bridges the 3px gap to the next one. On the selected row the path has
         arrived: it stops on its own elbow — 2rem plus the elbow's own 1.5px,
         so the two meet as a corner — rather than carrying on to the row's
         bottom edge and branching into nothing. This is the same rule
         that stops the grey spine on the last child's elbow; an accent that
         ran past it would be the one line in the tree pointing at no row. -->
    <span
      class="pointer-events-none absolute top-0 left-[1.125rem] w-[0.09375rem] rounded-[0.0625rem] bg-primary {selected
        ? 'h-[2.09375rem]'
        : '-bottom-[0.1875rem]'}"
      aria-hidden="true"
    ></span>
  {/if}
  <span
    class="pointer-events-none absolute top-[2rem] left-[1.125rem] w-[1.125rem] {selected
      ? 'h-[0.09375rem] rounded-[0.0625rem] bg-primary'
      : 'h-px bg-[color-mix(in_oklch,var(--foreground)_14%,transparent)]'}"
    aria-hidden="true"
  ></span>

  <span class="flex min-w-0 flex-1 flex-col">
    <!-- Where this session's work lives, and what it is doing — both facts
         *about* the title rather than the title itself, so they take the
         supporting line and leave the name below them alone. The task row above
         orders its two lines exactly this way; a tree whose levels read in
         opposite directions makes the eye change gear on every step down it.

         This line starts 44px in, so it is the first thing a narrow column
         crushes: a worktree slug has barely half the width the title below it
         gets. One step down in size hands some of that back, the `solus/`
         namespace is dropped from the slug itself, and the branch is capped at
         two thirds of the line so it stays a supporting detail rather than a
         second title — the row's tooltip reads the same slug, untruncated. -->
    <span class="flex h-4 items-center gap-[0.5625rem] text-xs @max-[15rem]:gap-1.5">
      <!-- The context cluster carries its own step down in ink. The trailing
           slot sits outside it: a mark that dimmed with the cluster could not
           be the one thing the row still states at full strength. -->
      <span
        class="flex min-w-0 flex-1 items-center gap-[0.5625rem] opacity-70 @max-[15rem]:gap-1.5"
      >
        {#if branchLabel}
          <span
            class="min-w-0 max-w-[66%] overflow-hidden text-ellipsis whitespace-nowrap"
            >{branchLabel}</span
          >
        {/if}
        <!-- Which machine the session runs on. Unlike the task row this is
             never omitted: a subtask list mixes hosts freely, so "here" has to
             be stated rather than inferred from the absence of a mark. -->
        <span class="flex shrink-0 items-center">
          {#if isRemote}
            <HostOperatingSystemIcon
              os={remoteOs}
              size={11}
              aria-label={host?.label}
            />
          {:else}
            <LaptopIcon
              size={11}
              class="@max-[15rem]:hidden"
              aria-label="Local"
            />
          {/if}
        </span>
      </span>

      <!-- One mark at rest, the row's actions on hover, in the same slot. The
           mark declares its own colour so it holds at full strength on a row
           that has receded, and the actions cross-fade over it rather than
           arriving beside it — the context line beside them is the only thing
           that yields width to a cluster appearing under the pointer, and the
           title below is never touched.

           Touch has no hover to swap on, so a coarse pointer keeps both.

           The column is reserved only while it holds a mark: an empty one still
           spends its own width and the gap before it, which pushed the mark a
           column left of the same mark on the task row above. -->
      <span
        class="relative ml-auto flex h-4 shrink-0 items-center justify-end {mark
          ? 'min-w-[0.875rem]'
          : ''}"
      >
        <span
          class="flex items-center transition-opacity duration-150 pointer-fine:group-hover/session:absolute pointer-fine:group-hover/session:right-0 pointer-fine:group-hover/session:opacity-0 pointer-fine:group-has-[:focus-visible]/session:absolute pointer-fine:group-has-[:focus-visible]/session:right-0 pointer-fine:group-has-[:focus-visible]/session:opacity-0"
        >
          {#if mark?.kind === "glyph"}
            <TaskStatusGlyph
              status={mark.status}
              size={13}
              label={attentionLabel(session.attention)}
            />
          {:else if mark?.kind === "unread"}
            <UnreadDot size={6} />
          {:else if mark?.kind === "guide"}
            <!-- Generating and ready are one object at two stages, so the mark
                 keeps its silhouette and only gains ink: an outline guide that
                 breathes while it is written, filled once it can be read.
                 Writing one is work in flight, so it takes the cool tone the
                 pane already spends on that. -->
            <span
              class="flex shrink-0 items-center {mark.state === 'ready'
                ? 'text-(--solus-status-complete)'
                : 'text-chart-5'}"
              role="img"
              aria-label={mark.state === "ready"
                ? "Review guide ready"
                : "Generating review guide"}
              title={mark.state === "ready"
                ? "Review guide ready"
                : "Generating review guide"}
            >
              <ReviewGuideGlyph
                size={14}
                weight={mark.state === "ready" ? "fill" : undefined}
                class={mark.state === "ready"
                  ? ""
                  : "animate-pulse [animation-duration:1.4s] motion-reduce:animate-none"}
              />
            </span>
          {:else if mark?.kind === "elapsed"}
            <!-- The clock separates on ink and weight, not hue — the same rule
                 one level up. Terracotta stays on the elbow, so the clock never
                 competes with the green of a pull request chip beside it. -->
            <span
              class="shrink-0 text-chrome-shelf tabular-nums {selected
                ? 'font-medium text-foreground'
                : 'text-[color-mix(in_oklch,var(--foreground)_45%,transparent)]'}"
              >{mark.label}</span
            >
          {:else if mark?.kind === "spinner"}
            <span
              class="flex shrink-0 items-center text-chart-5"
              role="img"
              aria-label={attentionLabel(session.attention)}
            >
              <SpinnerGapIcon size={13} class="animate-spin" />
            </span>
          {/if}
        </span>

        <!-- Durable children keep their workflow actions after their tab closes.
             Closing is available only for a mounted session. -->
        {#if session.tabId || session.taskId}
          <span
            class="pointer-events-none absolute inset-y-0 right-0 -mr-1 flex items-center gap-px opacity-0 transition-opacity duration-150 pointer-coarse:pointer-events-auto pointer-coarse:static pointer-coarse:opacity-100 pointer-fine:group-hover/session:pointer-events-auto pointer-fine:group-hover/session:static pointer-fine:group-hover/session:opacity-100 pointer-fine:group-has-[:focus-visible]/session:pointer-events-auto pointer-fine:group-has-[:focus-visible]/session:static pointer-fine:group-has-[:focus-visible]/session:opacity-100"
          >
            <!-- Same three actions, same order, as the task row above it —
                 including dropping snooze on a narrow column so the hover
                 cluster stops eating the title. -->
            <button
              class="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-[color,background] duration-[120ms] hover:bg-[color-mix(in_oklch,var(--foreground)_7%,transparent)] hover:text-foreground @max-[15rem]:hidden"
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
                class="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-[color,background] duration-[120ms] hover:bg-[color-mix(in_oklch,var(--foreground)_7%,transparent)] hover:text-foreground"
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
                class="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-[color,background] duration-[120ms] hover:bg-[color-mix(in_oklch,var(--foreground)_7%,transparent)] hover:text-foreground"
                title="Remove from sidebar"
                aria-label="Remove session from sidebar"
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
    </span>

    <!-- The name of the thing, alone on its line and pointed at by the elbow.
         The box is pinned to the title's own line height so the rename wash
         cannot resize the row or drag the context line above it around, which
         is why the height holds while renaming rather than being handed to the
         input.

         2px rather than the task row's 8px, because this row is 46px to the
         task row's 62px and has less slack to separate it from its neighbours:
         13px between sibling rows against 2px inside one keeps the ratio that
         binds the context line to this title instead of to the row above —
         neither row carries a plate to do it. -->
    <span class="mt-0.5 flex h-[1.125rem] items-center gap-[0.5625rem]">
      {#if renaming}
        <SessionNameInput
          value={session.label}
          class="text-workspace-chrome {titleIsEmphasized
            ? 'font-medium '
            : ''}"
          onCommit={onRename}
          onCancel={onRenameCancel}
        />
      {:else}
        <span
          class="min-w-0 flex-1 overflow-hidden text-workspace-chrome leading-[1.125rem] text-ellipsis whitespace-nowrap {titleIsEmphasized
            ? 'font-medium '
            : ''}">{session.label}</span
        >
      {/if}
    </span>
  </span>
</div>
    {/snippet}
  </TooltipUI.Trigger>
  <SessionSidebarTooltip
    title={session.label}
    projectKey={session.projectKey}
    {projectLabel}
    branchName={session.branchName}
    serverId={session.serverId}
    attention={session.attention}
    reviewGuideStatus={session.reviewGuideStatus}
  />
</TooltipUI.Root>

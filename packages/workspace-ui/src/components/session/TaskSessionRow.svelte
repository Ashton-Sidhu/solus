<script lang="ts">
  import {
    ClipboardCheck as ClipboardCheckIcon,
    LoaderCircle as SpinnerGapIcon,
    X as XIcon,
  } from "@lucide/svelte";
  import type { SidebarSessionChild } from "../../contexts/workspace/session-sidebar.store.svelte";
  import { attentionLabel } from "../../lib/sessionUtils";
  import { shouldActivateRenameableRow } from "../../lib/rename-input";
  import { liveActivityClock } from "../../lib/shared-clock";
  import SessionNameInput from "./SessionNameInput.svelte";
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
  import { alignStatusAnimationPhase } from "./lib/status-animation-phase";

  interface Props {
    /** A session the row's session delegated, listed under that row. */
    session: SidebarSessionChild;
    /** This session is the one on screen. */
    isCurrent: boolean;
    /** The parent's card is raised: a hover takes a wash, not a second plate. */
    inRaisedCard: boolean;
    /** The project of the row this session is listed under (`SidebarTask.groupKey`). */
    groupKey: string;
    projectLabel: string;
    /** A share link's guest is not told which host runs the session (host-sharing.md §10). */
    isGuest: boolean;
    /** True while this row's name is being edited in place. */
    renaming: boolean;
    onSelect: () => void;
    /** Rename this row where it sits, the same edit the context menu opens. */
    onStartRename: () => void;
    onRename: (next: string) => void;
    onRenameCancel: () => void;
    onMore: (event: MouseEvent | PointerEvent) => void;
    onClose: () => void;
    /** Start a drag of this session onto an input bar. Absent on touch. */
    onDragStart?: (event: DragEvent) => void;
  }
  let {
    session,
    isCurrent,
    inRaisedCard,
    groupKey,
    projectLabel,
    isGuest,
    renaming,
    onSelect,
    onStartRename,
    onRename,
    onRenameCancel,
    onMore,
    onClose,
    onDragStart,
  }: Props = $props();

  const status = $derived(taskStatusFor(session.attention));
  // The session you are reading leads in weight, except for a read error,
  // whose glyph already states it.
  const titleIsEmphasized = $derived(
    shouldEmphasizeTitle(status, session.unread, isCurrent),
  );
  // A started session recedes like any row you are not reading, unless it
  // asks for you: the one on screen and one with news keep full ink.
  const recedes = $derived(shouldRecedeRow(status, session.unread, false, isCurrent));

  let now = $state(Date.now());
  $effect(() => {
    if (status !== "running") return;
    return liveActivityClock.subscribe((value) => {
      now = value;
    });
  });

  // The same ladder the row above spends, one level down: a session row is a
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

{#snippet trailing()}
  <!-- One mark at rest, the row's actions on hover, in the same slot. The
       mark declares its own colour so it holds at full strength on a row
       that has receded, and the actions cross-fade over it rather than
       arriving beside it — the context line beside them is the only thing
       that yields width to a cluster appearing under the pointer, and the
       title below is never touched.

       Touch has no hover to swap on, so a coarse pointer keeps both.

       The faded mark also gives up its pointer events: it goes out of flow
       at right-0, which paints it above the in-flow actions that replaced
       it, and an invisible box still answers a click. Without this it ate
       the presses aimed at the check and the cross beneath it.

       The column is reserved only while it holds a mark: an empty one still
       spends its own width and the gap before it, which pushed the mark a
       column left of the same mark on the row above. -->
  <span
    class="relative ml-auto flex h-4 shrink-0 items-center justify-end {mark
      ? 'min-w-[0.875rem]'
      : ''}"
  >
    <span
      class="flex items-center transition-opacity duration-150 pointer-fine:group-hover/session:pointer-events-none pointer-fine:group-hover/session:absolute pointer-fine:group-hover/session:right-0 pointer-fine:group-hover/session:opacity-0 pointer-fine:group-has-[:focus-visible]/session:pointer-events-none pointer-fine:group-has-[:focus-visible]/session:absolute pointer-fine:group-has-[:focus-visible]/session:right-0 pointer-fine:group-has-[:focus-visible]/session:opacity-0"
    >
      {#if mark?.kind === "glyph"}
        <TaskStatusGlyph
          status={mark.status}
          size={13}
          label={attentionLabel(session.attention, session.limitResetsAt)}
        />
      {:else if mark?.kind === "unread"}
        <UnreadDot size={12} />
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
          onanimationstart={alignStatusAnimationPhase}
          aria-label={mark.state === "ready"
            ? "Review guide ready"
            : "Generating review guide"}
          title={mark.state === "ready"
            ? "Review guide ready"
            : "Generating review guide"}
        >
          <ClipboardCheckIcon
            size={14}
            class={mark.state === "ready"
              ? ""
              : "animate-pulse [animation-duration:1.4s] motion-reduce:animate-none"}
          />
        </span>
      {:else if mark?.kind === "elapsed"}
        <!-- The clock states its time in full ink, not hue. Terracotta
             stays on the elbow, so the clock never competes with the green
             of a pull request chip beside it. -->
        <span
          class="shrink-0 text-sidebar-time font-medium tabular-nums text-foreground"
          >{mark.label}</span
        >
      {:else if mark?.kind === "spinner"}
        <span
          class="flex shrink-0 items-center text-chart-5"
          role="img"
          onanimationstart={alignStatusAnimationPhase}
          aria-label={attentionLabel(session.attention, session.limitResetsAt)}
        >
          <SpinnerGapIcon size={13} class="animate-spin" />
        </span>
      {/if}
    </span>

    {#if session.tabId}
      <span
        class="pointer-events-none absolute inset-y-0 right-0 -mr-1 flex items-center gap-px opacity-0 transition-opacity duration-150 pointer-coarse:pointer-events-auto pointer-coarse:static pointer-coarse:opacity-100 pointer-fine:group-hover/session:pointer-events-auto pointer-fine:group-hover/session:static pointer-fine:group-hover/session:opacity-100 pointer-fine:group-has-[:focus-visible]/session:pointer-events-auto pointer-fine:group-has-[:focus-visible]/session:static pointer-fine:group-has-[:focus-visible]/session:opacity-100"
      >
        <button
          class="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-[color,background] duration-[120ms] hover:bg-[color-mix(in_oklch,var(--foreground)_7%,transparent)] hover:text-foreground"
          title="Archive"
          aria-label="Archive session"
          onclick={(event) => {
            event.stopPropagation();
            onClose();
          }}
        >
          <XIcon size={13} weight="bold" />
        </button>
      </span>
    {/if}
  </span>
{/snippet}

{#snippet title()}
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
      class="min-w-0 flex-1 overflow-hidden text-workspace-chrome leading-[1.125rem] text-ellipsis whitespace-nowrap transition-[font-weight] duration-150 {titleIsEmphasized
        ? 'font-medium '
        : ''}">{session.label}</span
    >
  {/if}
{/snippet}

<!-- A session listed one step in under the session that started it. In the
     raised card a row takes a wash, never a second plate. -->
<TooltipUI.Root>
  <TooltipUI.Trigger>
    {#snippet child({ props: tooltipProps })}
<div
  {...tooltipProps}
  class="group/session relative flex h-8 cursor-pointer items-center gap-[0.5625rem] rounded-md pr-2 pl-2.5 @max-[15rem]:gap-1.5 transition-[background,color,box-shadow] duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring {inRaisedCard ? 'hover:bg-[color-mix(in_oklch,var(--foreground)_4%,transparent)]' : 'hover:bg-card hover:shadow-[0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_10%,transparent),0_2px_6px_color-mix(in_oklch,var(--foreground)_8%,transparent)] dark:hover:bg-[color-mix(in_oklch,var(--card)_94%,white)]'} {recedes
    ? 'text-[color-mix(in_oklch,var(--solus-text-secondary)_75%,transparent)] hover:text-foreground'
    : 'text-foreground'} {isCurrent
    ? inRaisedCard
      ? 'bg-[color-mix(in_oklch,var(--foreground)_4%,transparent)]'
      : 'bg-card shadow-[0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_10%,transparent),0_2px_6px_color-mix(in_oklch,var(--foreground)_8%,transparent)] dark:bg-[color-mix(in_oklch,var(--card)_94%,white)]'
    : ''}"
  role="treeitem"
  tabindex="-1"
  data-tab-id={session.tabId}
  data-nested-session=""

  aria-selected={isCurrent}
  aria-label={session.label}
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
  draggable={!!onDragStart && !renaming}
  ondragstart={onDragStart}
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
  <!-- A delegated session is one line: its name and its trailing slot.
       Its branch and host are in the tooltip. -->
  <span class="flex min-w-0 flex-1 items-center gap-[0.5625rem]">
    {@render title()}
    {@render trailing()}
  </span>
</div>
    {/snippet}
  </TooltipUI.Trigger>
  <SessionSidebarTooltip
    title={session.label}
    projectKey={session.projectKey}
    {groupKey}
    {projectLabel}
    branchName={session.branchName}
    serverId={session.serverId}
    {isGuest}
    provider={session.provider}
    modelId={session.modelId}
    attention={session.attention}
    limitResetsAt={session.limitResetsAt}
    reviewGuideStatus={session.reviewGuideTooltipStatus}
  />
</TooltipUI.Root>

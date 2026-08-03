<script lang="ts">
  import { DotsThreeIcon, XIcon } from "phosphor-svelte";
  import type { SidebarSessionChild } from "../../contexts/workspace/session-sidebar.store.svelte";
  import { attentionLabel } from "../../lib/sessionUtils";
  import { liveActivityClock } from "../../lib/shared-clock";
  import SessionNameInput from "./SessionNameInput.svelte";
  import TaskStatusGlyph from "./TaskStatusGlyph.svelte";
  import {
    formatElapsed,
    hasGlyph,
    sidebarTitleNeedsEmphasis,
    taskStatusFor,
  } from "./lib/task-list";

  interface Props {
    child: SidebarSessionChild;
    selected: boolean;
    /** The parent task holds the session you are reading, so this whole cluster
     *  stays out of the falloff. */
    onPath: boolean;
    /** True while this row's name is being edited in place. */
    renaming: boolean;
    onSelect: () => void;
    onRename: (next: string) => void;
    onRenameCancel: () => void;
    onMore: (event: MouseEvent) => void;
    onClose: () => void;
  }
  let {
    child,
    selected,
    onPath,
    renaming,
    onSelect,
    onRename,
    onRenameCancel,
    onMore,
    onClose,
  }: Props = $props();

  const status = $derived(taskStatusFor(child.attention));
  const titleIsEmphasized = $derived(
    selected ||
      sidebarTitleNeedsEmphasis(status, child.attention === "unread"),
  );
  const runStartedAt = $derived(child.runStartedAt);

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

  const iconButton =
    "flex size-[1.25rem] shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-[color,background] duration-[120ms] hover:bg-accent hover:text-foreground";
</script>

<!-- One step in from the task title's spine, with no mark of its own: the
     indentation carries the hierarchy, so nothing here needs a box. -->
<div
  class="group/sub relative flex h-[2.125rem] cursor-pointer items-center gap-[0.5625rem] rounded pr-2 pl-6 transition-[background] duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring hover:bg-accent"
  role="treeitem"
  tabindex="-1"
  data-tab-id={child.tabId}
  aria-selected={selected}
  aria-label={child.label}
  onclick={onSelect}
  oncontextmenu={onMore}
  onkeydown={(event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect();
    }
  }}
>
  {#if renaming}
    <SessionNameInput
      value={child.label}
      onCommit={onRename}
      onCancel={onRenameCancel}
    />
  {:else}
    <span
      class="min-w-0 flex-1 overflow-hidden text-[0.78125rem] text-ellipsis whitespace-nowrap transition-opacity duration-150 {titleIsEmphasized
        ? 'font-[560]'
        : ''} {onPath
        ? 'opacity-100'
        : 'opacity-40 group-hover/task:opacity-100'} {selected
        ? 'text-foreground'
        : 'text-muted-foreground'}">{child.label}</span
    >
  {/if}

  <!-- The margin never dims and never swaps out on hover. -->
  {#if hasGlyph(status)}
    <TaskStatusGlyph
      {status}
      size={13}
      label={attentionLabel(child.attention)}
    />
  {:else if elapsed}
    <span
      class="shrink-0 font-mono text-[0.65625rem] text-muted-foreground tabular-nums transition-opacity duration-150 {onPath
        ? 'opacity-80'
        : 'opacity-35 group-hover/task:opacity-80'}">{elapsed}</span
    >
  {/if}

  <span class="-mr-0.5 hidden shrink-0 items-center gap-0.5 group-hover/sub:flex">
    <button
      class={iconButton}
      title="More"
      aria-label="More actions"
      onclick={(event) => {
        event.stopPropagation();
        onMore(event);
      }}
    >
      <DotsThreeIcon size={12} weight="bold" />
    </button>
    <button
      class={iconButton}
      title="Close session"
      aria-label="Close session"
      onclick={(event) => {
        event.stopPropagation();
        onClose();
      }}
    >
      <XIcon size={11} weight="bold" />
    </button>
  </span>
</div>

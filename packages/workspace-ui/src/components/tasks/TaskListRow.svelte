<script lang="ts">
  import type { Snippet } from "svelte";
  import type { TaskStatus } from "@solus/contracts/task-types";
  import ListAvatar from "../ui/list-page/ListAvatar.svelte";
  import ListChip from "../ui/list-page/ListChip.svelte";
  import type { ListRowSpec } from "../ui/list-page/list-page";
  import { swipeActions } from "../../lib/swipe-actions";
  import { STATUS_META, TASK_STATUS_SWIPE_REVEAL_WIDTH } from "./lib/tasks-api";
  import TaskStatusSwipeControls from "./TaskStatusSwipeControls.svelte";

  /** One task in the list below the record rung — the redesign's drawer row.
   *
   *  `ListRow` reflows into a three-line record at this width, which is the
   *  right answer for a pull request (a branch, a check state and a diffstat all
   *  want saying) and the wrong one for a task, where the title is nearly the
   *  whole row. So the task list takes the row the spec draws for it: a fixed
   *  62px, a state tile leading, one line of title, one line of facts.
   *
   *  Fixed height is not a style choice here. The row sits in a virtualiser that
   *  is told an offset before the browser lays the title out, so a title free to
   *  wrap makes that offset a guess — which is exactly how a selected row came
   *  to paint over the row beneath it. One line of title, one number, no
   *  disagreement. `TASK_RECORD_ROW_HEIGHT` is this row's height.
   *
   *  Its twin is `MobileTaskRow` in the web client's session drawer, which draws
   *  the same 62px row from a `SidebarTask`. They share the spec and its
   *  measurements, not a module: that one lives in `apps/client` and carries the
   *  drawer's own concerns (project favicon, review glyph, snooze). Converging
   *  them means promoting it to `ui/`, which is a change of its own. */
  interface Props {
    row: ListRowSpec;
    /** Drives the leading tile's glyph and tint — the row's one use of colour. */
    status: TaskStatus;
    selected?: boolean;
    onSelect?: () => void;
    onSetStatus: (status: TaskStatus) => void;
    revealed?: boolean;
    onRevealChange?: (revealed: boolean) => void;
    onContextMenu?: (event: MouseEvent) => void;
    /** The page's selection checkbox, a sibling of the button rather than a
     *  child, so no interactive element nests inside another. */
    leading?: Snippet;
  }
  let {
    row,
    status,
    selected = false,
    onSelect,
    onSetStatus,
    revealed = false,
    onRevealChange,
    onContextMenu,
    leading,
  }: Props = $props();

  const meta = $derived(STATUS_META[status]);
  const lead = $derived(row.people[0] ?? null);
  function setStatus(next: TaskStatus) {
    onRevealChange?.(false);
    if (next !== status) onSetStatus(next);
  }
</script>

<div
  class="relative h-[3.875rem] w-full overflow-hidden rounded-2xl"
  data-selected={selected}
  oncontextmenu={onContextMenu}
  role="group"
>
  <TaskStatusSwipeControls {status} {revealed} onSelect={setStatus} />

  <div
    class="relative flex h-full w-full items-center gap-[0.6875rem] px-3 shadow-[0.375rem_0_0.875rem_-0.375rem_rgba(0,0,0,0.28)] {selected
      ? 'bg-[color-mix(in_oklch,var(--foreground)_7%,var(--background))]'
      : 'bg-background hover:bg-[var(--wash-1)] active:bg-[var(--wash-1)]'}"
    use:swipeActions={{
      revealWidth: TASK_STATUS_SWIPE_REVEAL_WIDTH,
      open: revealed,
      onRevealChange: (open) => onRevealChange?.(open),
    }}
  >
    {#if leading}{@render leading()}{/if}

    <button
      type="button"
      class="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-[0.6875rem] overflow-hidden border-0 bg-transparent p-0 text-left focus-visible:outline-none [-webkit-tap-highlight-color:transparent]"
      onclick={() => revealed ? onRevealChange?.(false) : onSelect?.()}
      data-list-row
    >
    <!-- The state, as a shape and a tint rather than a word. The word itself is
         already the group header this row sits under, so spelling it again on
         every row would be the list repeating itself sixty times. -->
    <span
      class="flex size-7 shrink-0 items-center justify-center rounded-lg"
      style="background:color-mix(in oklch, var({meta.token}) 20%, transparent);color:color-mix(in oklch, var({meta.token}) 62%, var(--foreground))"
      aria-hidden="true"
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 14 14"
        fill="none"
        stroke="currentColor"
        stroke-width="1.45"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d={meta.glyph} />
      </svg>
    </span>

    <span class="flex min-w-0 flex-1 flex-col">
      <span
        class="truncate text-sm font-medium tracking-[-0.005em] text-foreground"
        title={row.title}
      >
        {row.title}
      </span>

      <!-- Line two, in the spec's order: what it is, how long ago, what is
           happening to it. Everything here is `shrink-0` except the sentence of
           machine state, which is the only part that can afford to lose its
           tail. -->
      <span class="mt-[0.1875rem] flex min-w-0 items-center gap-1.5 text-xs">
        <span class="shrink-0 font-mono text-muted-foreground opacity-80">
          {row.ident}
        </span>
        <span class="shrink-0 text-muted-foreground opacity-40" aria-hidden="true">·</span>
        <span
          class="shrink-0 font-mono tabular-nums text-muted-foreground"
          title={row.timeTitle}
        >
          {row.time}
        </span>
        {#if row.meta}
          <span class="shrink-0 text-muted-foreground opacity-40" aria-hidden="true">·</span>
          <span class="min-w-0 truncate text-muted-foreground">{row.meta}</span>
        {/if}
        <!-- A label or a priority that needed colour. Kept because "overdue" and
             "urgent" are the two facts a task list is scanned for; dropped from
             the spec's drawer row only because a drawer has neither. -->
        {#each row.chips as chip (chip.label)}
          <span class="flex shrink-0 items-center"><ListChip {chip} /></span>
        {/each}
      </span>
    </span>

    <!-- Who it belongs to, at the right edge. The drawer row has no assignee to
         draw; a shared task list does, and it is the one fact the title cannot
         imply. -->
    {#if lead}
      <span class="flex size-5 shrink-0 items-center justify-center">
        <ListAvatar person={lead} />
      </span>
    {/if}
    </button>
  </div>
</div>

<script lang="ts">
  import type { Snippet } from "svelte";
  import type { IssueStatusCategory } from "@solus/contracts/task-sources";
  import ListAvatar from "../ui/list-page/ListAvatar.svelte";
  import ListChip from "../ui/list-page/ListChip.svelte";
  import SourceLogo from "../ui/list-page/SourceLogo.svelte";
  import LabelChip from "../ui/labels/LabelChip.svelte";
  import { swipeActions } from "../../lib/swipe-actions";
  import { TASK_CATEGORY_SWIPE_REVEAL_WIDTH } from "./lib/tasks-api";
  import type { TaskRowSpec } from "./lib/tasks-list-view";
  import { taskStatusGlyph } from "./lib/task-row-styles";
  import TaskStatusSwipeControls from "./TaskStatusSwipeControls.svelte";

  /** One task in the list, in the pull request row's shape (`PrListRow`): the
   *  state glyph, then a two-by-two grid. The title leads line one and the
   *  assignees and the state that needs colour close it. Line two is where the
   *  task lives — reference, place, machine state, labels — with the age at
   *  its end.
   *
   *  The row has a fixed height in each layout (`TASK_LIST_ROW_HEIGHT`), so
   *  the virtualiser's number is never a guess. Beside an open task it gets
   *  more vertical room and sheds facts by its own width — labels, then the
   *  place, then the age.
   *
   *  Under the row are the swipe controls that move a task to a status
   *  category. Only a touch swipes, so the row's surfaces are opaque: a hover
   *  wash must not show the controls through it. */
  interface Props {
    row: TaskRowSpec;
    split?: boolean;
    selected?: boolean;
    onSelect?: () => void;
    onSetCategory: (category: IssueStatusCategory) => void;
    revealed?: boolean;
    onRevealChange?: (revealed: boolean) => void;
    onContextMenu?: (event: MouseEvent) => void;
    /** The page's selection checkbox, a sibling of the button rather than a
     *  child, so no interactive element nests inside another. */
    leading?: Snippet;
  }
  let {
    row,
    split = false,
    selected = false,
    onSelect,
    onSetCategory,
    revealed = false,
    onRevealChange,
    onContextMenu,
    leading,
  }: Props = $props();

  const glyph = $derived(taskStatusGlyph(row.category));
  const place = $derived([row.place?.project, row.place?.host].filter(Boolean).join(" · "));
  function setCategory(next: IssueStatusCategory) {
    onRevealChange?.(false);
    if (next !== row.category) onSetCategory(next);
  }
</script>

{#snippet dot()}
  <span class="shrink-0 text-muted-foreground/50" aria-hidden="true">·</span>
{/snippet}

<div
  class="relative w-full overflow-hidden rounded-lg {split ? 'h-[76px]' : 'h-[62px]'}"
  data-selected={selected}
  oncontextmenu={onContextMenu}
  role="group"
>
  <TaskStatusSwipeControls category={row.category} {revealed} onSelect={setCategory} />

  <div
    class="group @container/task-row relative flex h-full w-full items-center px-3 transition-colors duration-150 {selected
      ? 'bg-[color-mix(in_oklch,var(--foreground)_7%,var(--background))]'
      : 'bg-background hover:bg-[color-mix(in_oklch,var(--foreground)_3%,var(--background))]'}"
    use:swipeActions={{
      revealWidth: TASK_CATEGORY_SWIPE_REVEAL_WIDTH,
      open: revealed,
      onRevealChange: (open) => onRevealChange?.(open),
    }}
  >
    {#if leading}{@render leading()}{/if}

    <button
      type="button"
      class="flex h-full min-w-0 flex-1 cursor-pointer items-center overflow-hidden border-0 bg-transparent p-0 text-left focus-visible:outline-none [-webkit-tap-highlight-color:transparent]"
      onclick={() => (revealed ? onRevealChange?.(false) : onSelect?.())}
      data-list-row
    >
      <span class="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5">
        <span
          class="flex size-4 items-center justify-center {glyph.toneClass}"
          role="img"
          aria-label={glyph.label}
          title={glyph.label}
        >
          <glyph.icon size={16} />
        </span>

        <span class="truncate text-sm font-medium text-foreground" title={row.title}>
          {row.title}
        </span>

        <!-- Who it belongs to and what needs colour, right-aligned so they
             read as a column down the list. -->
        <span class="flex shrink-0 items-center justify-end gap-2 text-xs">
          {#each row.chips as chip (chip.label)}
            <ListChip {chip} />
          {/each}
          {#if row.people.length > 0}
            <span class="flex items-center -space-x-1">
              {#each row.people.slice(0, 3) as person (person.id)}
                <span class="flex rounded-full ring-1 ring-background">
                  <ListAvatar {person} size={19} />
                </span>
              {/each}
            </span>
          {/if}
        </span>

        <!-- Where it lives. Every fact is `shrink-0` and the line clips at its
             end: labels go before the reference, which is how a row is found. -->
        <span
          class="col-start-2 flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-xs text-muted-foreground"
        >
          {#if row.source}
            <span class="flex shrink-0 items-center gap-1.5">
              <SourceLogo source={row.source.id} title={row.source.title} />
              <span class="font-mono tabular-nums">{row.ident}</span>
            </span>
          {:else}
            <span class="shrink-0 font-mono tabular-nums">{row.ident}</span>
          {/if}
          {#if place}
            <span class="hidden shrink-0 items-center gap-1.5 @min-[22rem]/task-row:flex">
              {@render dot()}
              <span>{place}</span>
            </span>
          {/if}
          {#if row.meta}
            {@render dot()}
            <span class="shrink-0">{row.meta}</span>
          {/if}
          {#if row.labels.length > 0}
            <span class="hidden shrink-0 items-center gap-1 @min-[32rem]/task-row:flex">
              {@render dot()}
              {#each row.labels as label (label)}
                <LabelChip {label} class="h-4 shrink-0 px-1.5 text-[10px] leading-4" />
              {/each}
              {#if row.moreLabels > 0}
                <span class="shrink-0 text-[10px] tabular-nums">+{row.moreLabels}</span>
              {/if}
            </span>
          {/if}
        </span>

        <span
          class="hidden justify-self-end text-[11px] whitespace-nowrap text-muted-foreground tabular-nums @min-[22rem]/task-row:inline"
          title={row.timeTitle}
        >
          {row.time}
        </span>
      </span>
    </button>
  </div>
</div>

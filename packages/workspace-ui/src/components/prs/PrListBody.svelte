<script lang="ts">
  import type { PullRequest } from "@solus/contracts/providers";
  import type { SvelteSet } from "svelte/reactivity";
  import {
    ListGroup,
    VirtualList,
    LIST_GROUP_HEADER_HEIGHT,
    type ListGroupSpec,
    type VirtualGroupItem,
  } from "../ui/list-page";
  import { PR_LIST_ROW_HEIGHT, type PrRowSpec } from "./lib/prs-list-view";
  import PrListRow from "./PrListRow.svelte";
  import PrPagination from "./PrPagination.svelte";

  /** The rows themselves: section headers and pull requests in one virtual
   *  list. Beside an open detail the list is narrower, not different: the row
   *  sheds its secondary facts by its own width (see `PrListRow`). */
  interface Props {
    items: VirtualGroupItem<ListGroupSpec<PrRowSpec>, PrRowSpec>[];
    height: number;
    activeKey: string | null;
    scrollTop: number;
    selectedKey: string | null;
    reviewSelection: SvelteSet<string>;
    /** Review checkboxes need a workspace to review in. */
    canReview: boolean;
    /** The host has more pages than the list holds. */
    hasMore: boolean;
    loadingMore: boolean;
    /** The list is at its row cap; more needs a narrower search. */
    loadCapped: boolean;
    prByKey: (key: string) => PullRequest | undefined;
    isSectionOpen: (key: string) => boolean;
    onToggleSection: (key: string) => void;
    onSelect: (pr: PullRequest) => void;
    onContextMenu: (event: MouseEvent, pr: PullRequest) => void;
    onToggleReview: (pr: PullRequest) => void;
    onLoadMore: () => void;
  }
  let {
    items,
    height,
    activeKey,
    scrollTop = $bindable(),
    selectedKey,
    reviewSelection,
    canReview,
    hasMore,
    loadingMore,
    loadCapped,
    prByKey,
    isSectionOpen,
    onToggleSection,
    onSelect,
    onContextMenu,
    onToggleReview,
    onLoadMore,
  }: Props = $props();
</script>

<VirtualList
  {items}
  {height}
  itemSize={(index) =>
    items[index].kind === "header" ? LIST_GROUP_HEADER_HEIGHT : PR_LIST_ROW_HEIGHT}
  keyOf={(item) => item.key}
  {activeKey}
  scrollOffset={scrollTop}
  onAfterScroll={({ offset }) => (scrollTop = offset)}
>
  {#snippet children(item, _index, style)}
    <div {style}>
      {#if item.kind === "header"}
        <ListGroup
          label={item.group.label}
          count={item.group.rows.length}
          open={isSectionOpen(item.group.key)}
          onToggle={() => onToggleSection(item.group.key)}
        >
          {#snippet children()}{/snippet}
        </ListGroup>
      {:else}
        {@const pr = prByKey(item.row.key)}
        {@const checked = reviewSelection.has(item.row.key)}
        {@const rowSelected = selectedKey === item.row.key || checked}
        {#snippet reviewCheckbox()}
          <button
            type="button"
            class="mr-2.5 grid size-3.5 shrink-0 cursor-pointer place-items-center rounded-[4px] border text-[10px] leading-none transition-opacity focus-visible:opacity-100 {checked
              ? 'border-primary bg-primary text-primary-foreground opacity-100'
              : 'border-border bg-background text-transparent opacity-0 group-hover:opacity-100'}"
            onclick={() => {
              if (pr) onToggleReview(pr);
            }}
            aria-pressed={checked}
            aria-label="Select for review"
          >
            ✓
          </button>
        {/snippet}
        <PrListRow
          row={item.row}
          selected={rowSelected}
          leading={canReview ? reviewCheckbox : undefined}
          onSelect={() => {
            if (pr) onSelect(pr);
          }}
          onContextMenu={(event) => {
            if (pr) onContextMenu(event, pr);
          }}
        />
      {/if}
    </div>
  {/snippet}
  {#snippet footer()}
    {#if hasMore || loadingMore}
      <PrPagination loading={loadingMore} capped={loadCapped} onLoad={onLoadMore} />
    {/if}
  {/snippet}
</VirtualList>

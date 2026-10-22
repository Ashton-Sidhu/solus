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
  import { PR_LIST_ROW_HEIGHT, PR_LIST_SPLIT_ROW_HEIGHT, type PrRowSpec } from "./lib/prs-list-view";
  import { prRowActions, type PrRowActionKind } from "./lib/pr-row-actions";
  import { Button } from "../ui/button";
  import type { PullRequest as StoredPullRequest } from "../../contexts/prs/pull-request.svelte";
  import PrListRow from "./PrListRow.svelte";
  import PrStackChip from "./PrStackChip.svelte";
  import PrPagination from "./PrPagination.svelte";

  /** The rows themselves: section headers and pull requests in one virtual
   *  list. Beside an open detail the list is narrower, not different: the row
   *  sheds its secondary facts by its own width (see `PrListRow`). */
  interface Props {
    items: VirtualGroupItem<ListGroupSpec<PrRowSpec>, PrRowSpec>[];
    height: number;
    split?: boolean;
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
    /** Shift is held: every row shows its quick actions. */
    showRowActions: boolean;
    prByKey: (key: string) => PullRequest | undefined;
    isSectionOpen: (key: string) => boolean;
    onToggleSection: (key: string) => void;
    onSelect: (pr: PullRequest) => void;
    onContextMenu: (event: MouseEvent, pr: PullRequest) => void;
    onToggleReview: (pr: PullRequest) => void;
    onRowAction: (pr: PullRequest, kind: PrRowActionKind) => void;
    /** The row's pull request in the store, for its stack menu and its churn by kind. */
    storedPullRequest: (pr: PullRequest) => StoredPullRequest | null;
    /** Open another layer of the row's stack. */
    onOpenStackLayer: (pr: PullRequest, number: number) => void;
    onLoadMore: () => void;
  }
  let {
    items,
    height,
    split = false,
    activeKey,
    scrollTop = $bindable(),
    selectedKey,
    reviewSelection,
    canReview,
    hasMore,
    loadingMore,
    loadCapped,
    showRowActions,
    prByKey,
    isSectionOpen,
    onToggleSection,
    onSelect,
    onContextMenu,
    onToggleReview,
    onRowAction,
    storedPullRequest,
    onOpenStackLayer,
    onLoadMore,
  }: Props = $props();
</script>

<VirtualList
  {items}
  {height}
  itemSize={(index) =>
    items[index].kind === "header"
      ? LIST_GROUP_HEADER_HEIGHT
      : split ? PR_LIST_SPLIT_ROW_HEIGHT : PR_LIST_ROW_HEIGHT}
  keyOf={(item) => item.key}
  {activeKey}
  scrollOffset={scrollTop}
  onScroll={(offset) => (scrollTop = offset)}
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
        {@const stored = pr ? storedPullRequest(pr) : null}
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
        <!-- Out of the tab order on purpose: they exist only while Shift is
             held, so focus would vanish with them. The keyboard runs the same
             actions as Shift+letter on the highlighted row. -->
        {#snippet quickActions()}
          {#if pr}
            <span class="ml-2 flex shrink-0 items-center gap-1">
              {#each prRowActions(pr) as action (action.kind)}
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  class="cursor-pointer gap-1.5"
                  tabindex={-1}
                  disabled={!!action.disabledReason}
                  title={action.disabledReason ?? `${action.menuLabel} (⇧${action.key})`}
                  onclick={() => onRowAction(pr, action.kind)}
                >
                  {action.label}
                  <span class="text-[10px] text-muted-foreground" aria-hidden="true">{action.key}</span>
                </Button>
              {/each}
            </span>
          {/if}
        {/snippet}
        {#snippet stackChip()}
          {#if pr && item.row.stack}
            <PrStackChip
              membership={item.row.stack}
              pullRequest={stored}
              onOpen={(number) => onOpenStackLayer(pr, number)}
            />
          {/if}
        {/snippet}
        <PrListRow
          row={item.row}
          {split}
          selected={rowSelected}
          leading={canReview ? reviewCheckbox : undefined}
          stack={item.row.stack ? stackChip : undefined}
          actions={showRowActions ? quickActions : undefined}
          breakdown={stored?.changeBreakdown}
          onWantBreakdown={() => void stored?.loadChangedFiles().catch(() => {})}
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

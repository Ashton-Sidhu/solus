<script lang="ts">
  import { LayoutGrid as AppIcon } from "@lucide/svelte";
  import { PAGE_SECONDARY_BTN } from "../../lib/page-chrome";
  import { appsStore } from "../../contexts/apps/apps.store.svelte";
  import PageEmpty from "../ui/PageEmpty.svelte";
  import WorkspaceAppCard from "./WorkspaceAppCard.svelte";
  import type { WorkspaceLedger } from "./lib/workspace-ledger.svelte";
  import type { WorkspaceAppItem } from "./lib/workspace-apps";

  /** The Apps tab of the Workspace page: the apps of every connected host, in the ledger's date buckets. */
  interface Props {
    ledger: WorkspaceLedger;
    onOpen: (item: WorkspaceAppItem) => void;
  }
  let { ledger, onOpen }: Props = $props();
</script>

{#if ledger.appItems.length === 0 && appsStore.isLoading}
  <div class="grid grid-cols-3 gap-3 pt-2 @max-[48rem]/pane:grid-cols-2 @max-[30rem]/pane:grid-cols-1" role="status" aria-busy="true" aria-label="Loading apps">
    {#each Array(3) as _, i (i)}
      <div class="h-[108px] animate-pulse rounded-xl bg-[var(--wash-2)]" style="opacity:{1 - i * 0.2}"></div>
    {/each}
  </div>
{:else if ledger.appItems.length === 0}
  <PageEmpty icon={AppIcon} title="No apps yet.">
    An agent makes an app when you ask for one.
  </PageEmpty>
{:else if ledger.filteredApps.length === 0}
  <PageEmpty title="No matches in this filter.">
    Try a different search or filter.
    {#snippet actions()}
      <button type="button" class={PAGE_SECONDARY_BTN} onclick={() => ledger.clearFilters()}>Clear filters</button>
    {/snippet}
  </PageEmpty>
{:else}
  {#each ledger.renderedAppGroups as group (group.key)}
    {@const groupOffset = ledger.appOffsetOf(group)}
    <div class="sticky top-0 z-[1] mt-3 flex h-[30px] items-center gap-2 bg-background px-1">
      <span class="text-[13px] font-medium text-foreground/80">{group.label}</span>
      <span class="text-xs tabular-nums text-muted-foreground">{group.total}</span>
    </div>
    <div class="grid grid-cols-3 gap-3 pt-1 pb-2 @max-[48rem]/pane:grid-cols-2 @max-[30rem]/pane:grid-cols-1">
      {#each group.items as item, j (item.rowKey)}
        <WorkspaceAppCard
          {item}
          selected={groupOffset + j === ledger.selectedIndex}
          query={ledger.filter.text}
          onOpen={() => {
            ledger.selectedIndex = groupOffset + j;
            onOpen(item);
          }}
        />
      {/each}
    </div>
  {/each}
{/if}

<script lang="ts">
  import { LibraryBig as BooksIcon, Pin as PushPinIcon, UserCheck as UserCheckIcon } from "@lucide/svelte";
  import { ListFilterGroup, ListFilterMenu, ListSortMenu } from "../ui/list-page";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { SORT_OPTIONS, type WorkspaceLedger } from "./lib/workspace-ledger.svelte";

  /**
   * The sort and the facets of the open tab. The facets cut works by project,
   * type, time, pin and review. An app has a project and a time, so its tab
   * keeps those two. A session has none, so its tab keeps only the search and
   * the sort.
   */
  let { ledger }: { ledger: WorkspaceLedger } = $props();
</script>

<ListSortMenu bind:value={ledger.sort} options={SORT_OPTIONS} ariaLabel="Sort workspace" />
{#if ledger.tab !== "shared-sessions"}
  <ListFilterMenu activeCount={ledger.activeFacetCount} onClear={() => ledger.clearFacets()}>
    <ListFilterGroup label="Project" options={ledger.projectOptions} selected={[ledger.filter.project]} onChange={(next) => (ledger.filter.project = next[0])} />
    {#if ledger.tab !== "apps"}
      <ListFilterGroup label="Type" icon={BooksIcon} options={ledger.typeOptions} selected={[ledger.filter.type]} onChange={(next) => (ledger.filter.type = next[0])} />
    {/if}
    <ListFilterGroup label="Time" options={ledger.timeOptions} selected={[ledger.filter.time]} onChange={(next) => (ledger.filter.time = next[0])} />
    {#if ledger.tab !== "apps"}
      <DropdownMenu.Separator />
      {#if ledger.tab === "yours"}
        <DropdownMenu.CheckboxItem checked={ledger.filter.pinnedOnly} closeOnSelect={false} onCheckedChange={(checked) => (ledger.filter.pinnedOnly = checked)}>
          <PushPinIcon size={14} class="shrink-0 text-muted-foreground" />
          <span class="flex-1">Pinned</span>
          <span class="mr-1 tabular-nums text-muted-foreground">{ledger.pinnedCount}</span>
        </DropdownMenu.CheckboxItem>
      {/if}
      <!-- Works a teammate asked the reader to review. -->
      <DropdownMenu.CheckboxItem checked={ledger.filter.awaitingMyReview} closeOnSelect={false} onCheckedChange={(checked) => (ledger.filter.awaitingMyReview = checked)} data-testid="filter-needs-my-review">
        <UserCheckIcon size={14} class="shrink-0 text-muted-foreground" />
        <span class="flex-1">Needs my review</span>
        <span class="mr-1 tabular-nums text-muted-foreground">{ledger.awaitingMyReviewCount}</span>
      </DropdownMenu.CheckboxItem>
    {/if}
  </ListFilterMenu>
{/if}

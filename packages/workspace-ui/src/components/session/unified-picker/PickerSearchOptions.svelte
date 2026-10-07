<script lang="ts">
  import {
    ArrowDownUp as SortIcon,
    ChevronDown as CaretDownIcon,
  } from "@lucide/svelte";
  import { BitsConfig } from "bits-ui";
  import * as DropdownMenu from "../../ui/dropdown-menu";
  import { ListFilterGroup } from "../../ui/list-page";
  import {
    PICKER_SORT_LABELS,
    type PickerSearchMode,
    type PickerSort,
  } from "./lib/picker-search";
  import {
    activeFilterCount,
    PICKER_AGENT_LABELS,
    PICKER_STATUS_LABELS,
    PICKER_UPDATED_LABELS,
    type PickerAgentFilter,
    type PickerFilters,
    type PickerStatusFilter,
    type PickerUpdatedFilter,
  } from "./lib/picker-filters";
  import { serversStore } from "../../../contexts/connections/servers.store.svelte";

  /**
   * The choices a reader makes about a query, to the right of the box it is
   * typed in: what order the hits come in, whether the hosts are asked what
   * was said or only the names of things, and what the list is narrowed to.
   * One menu, because a reader who changes one is usually about to change
   * another, and the header row has room for one control beside the field on
   * a phone.
   */
  interface Props {
    sort: PickerSort;
    mode: PickerSearchMode;
    filters: PickerFilters;
    onSort: (sort: PickerSort) => void;
    onMode: (mode: PickerSearchMode) => void;
    onFilters: (filters: PickerFilters) => void;
    /** Where the menu portals, so it paints above the picker's scrim. */
    portalTarget: HTMLElement | null;
    open?: boolean;
  }
  let { sort, mode, filters, onSort, onMode, onFilters, portalTarget, open = $bindable(false) }: Props = $props();

  const menuPortalProps = $derived({ to: portalTarget ?? undefined });
  const keywordsOnly = $derived(mode === "keywords");
  const filterCount = $derived(activeFilterCount(filters));
  /** Tinted while the list is narrowed, as it is while names only are searched. */
  const narrowed = $derived(keywordsOnly || filterCount > 0);
  // The machines sessions run on. Offered once there is more than one to tell
  // apart, or while one is chosen, so the filter can always be cleared.
  const hosts = $derived(serversStore.executionServers);
  const offersHosts = $derived(hosts.length > 1 || filters.host !== "any");
  // A chosen host Solus no longer lists stays an option, so the reader can see
  // why the list is narrowed.
  const hostOptions = $derived([
    { value: "any", label: "Any host" },
    ...hosts.map((host) => ({ value: host.id, label: host.label })),
    ...(filters.host === "any" || hosts.some((host) => host.id === filters.host)
      ? []
      : [{ value: filters.host, label: serversStore.hostFor(filters.host)?.label ?? filters.host }]),
  ]);
</script>

<DropdownMenu.Root bind:open>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <!-- The sort chip every list page carries: a quiet ringed chip in the
           chrome rung, muted until hovered or opened. It is a filter, not a
           place, so it does not borrow the project crumb's weight. Tinted
           while the search is narrowed to names or by a filter: a list that is
           not showing everything says so on its face, not only when opened. -->
      <button
        {...props}
        type="button"
        class="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-workspace-chrome font-normal transition-colors duration-150 hover:bg-[var(--wash-2)] hover:text-foreground max-md:size-11 max-md:justify-center max-md:rounded-[0.625rem] max-md:px-0 max-md:shadow-none {narrowed
          ? 'bg-[color-mix(in_oklch,var(--primary)_13%,transparent)] text-[color:color-mix(in_oklch,var(--primary)_82%,var(--foreground))]'
          : open
            ? 'bg-[var(--wash-2)] text-foreground'
            : 'text-muted-foreground shadow-[inset_0_0_0_.5px_color-mix(in_oklch,var(--foreground)_13%,transparent)]'}"
        aria-label="Sort, search and filter options"
        title="Sort, search and filter options"
      >
        <SortIcon class="size-3.5 shrink-0 opacity-70" />
        <span class="truncate max-md:hidden"
          >{PICKER_SORT_LABELS[sort]}{keywordsOnly ? " · Keywords" : ""}{filterCount
            ? ` · ${filterCount} ${filterCount === 1 ? "filter" : "filters"}`
            : ""}</span
        >
        <CaretDownIcon
          size={12}
          class="shrink-0 opacity-50 transition-transform duration-200 max-md:hidden {open ? 'rotate-180' : ''}"
        />
      </button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content side="bottom" align="end" sideOffset={6} class="min-w-[13.5rem]" portalProps={menuPortalProps}>
    <DropdownMenu.RadioGroup value={sort} onValueChange={(value) => onSort(value as PickerSort)}>
      <DropdownMenu.GroupHeading>Order by</DropdownMenu.GroupHeading>
      <DropdownMenu.RadioItem value="relevance">
        <span class="flex-1">{PICKER_SORT_LABELS.relevance}</span>
      </DropdownMenu.RadioItem>
      <DropdownMenu.RadioItem value="recency">
        <span class="flex-1">{PICKER_SORT_LABELS.recency}</span>
      </DropdownMenu.RadioItem>
    </DropdownMenu.RadioGroup>
    <DropdownMenu.Separator />
    <DropdownMenu.RadioGroup
      value={mode}
      onValueChange={(value) => onMode(value as PickerSearchMode)}
    >
      <DropdownMenu.GroupHeading>Search in</DropdownMenu.GroupHeading>
      <DropdownMenu.RadioItem value="full-text">
        <span class="flex-1">Everything said</span>
      </DropdownMenu.RadioItem>
      <DropdownMenu.RadioItem value="keywords">
        <span class="flex-1">Keywords in names only</span>
      </DropdownMenu.RadioItem>
    </DropdownMenu.RadioGroup>
    <DropdownMenu.Separator />
    <DropdownMenu.RadioGroup
      value={filters.updated}
      onValueChange={(value) => onFilters({ ...filters, updated: value as PickerUpdatedFilter })}
    >
      <DropdownMenu.GroupHeading>Updated</DropdownMenu.GroupHeading>
      {#each Object.entries(PICKER_UPDATED_LABELS) as [value, label] (value)}
        <DropdownMenu.RadioItem {value}><span class="flex-1">{label}</span></DropdownMenu.RadioItem>
      {/each}
    </DropdownMenu.RadioGroup>
    <DropdownMenu.Separator />
    <DropdownMenu.RadioGroup
      value={filters.status}
      onValueChange={(value) => onFilters({ ...filters, status: value as PickerStatusFilter })}
    >
      <DropdownMenu.GroupHeading>Task status</DropdownMenu.GroupHeading>
      {#each Object.entries(PICKER_STATUS_LABELS) as [value, label] (value)}
        <DropdownMenu.RadioItem {value}><span class="flex-1">{label}</span></DropdownMenu.RadioItem>
      {/each}
    </DropdownMenu.RadioGroup>
    <DropdownMenu.Separator />
    <DropdownMenu.RadioGroup
      value={filters.agent}
      onValueChange={(value) => onFilters({ ...filters, agent: value as PickerAgentFilter })}
    >
      <DropdownMenu.GroupHeading>Session agent</DropdownMenu.GroupHeading>
      {#each Object.entries(PICKER_AGENT_LABELS) as [value, label] (value)}
        <DropdownMenu.RadioItem {value}><span class="flex-1">{label}</span></DropdownMenu.RadioItem>
      {/each}
    </DropdownMenu.RadioGroup>
    {#if offersHosts}
      <DropdownMenu.Separator />
      <!-- A submenu, because the hosts are as many as the person has saved:
           the list scrolls in its own bounded panel instead of lengthening
           this one. It portals into the picker's layer, as this menu does. -->
      <BitsConfig defaultPortalTo={portalTarget ?? undefined}>
        <ListFilterGroup
          label="Session host"
          options={hostOptions}
          selected={[filters.host]}
          onChange={([host]) => onFilters({ ...filters, host: host ?? "any" })}
        />
      </BitsConfig>
    {/if}
  </DropdownMenu.Content>
</DropdownMenu.Root>

<script lang="ts">
  import {
    ArrowDownUp as SortIcon,
    ChevronDown as CaretDownIcon,
  } from "@lucide/svelte";
  import * as DropdownMenu from "../../ui/dropdown-menu";
  import {
    PICKER_SORT_LABELS,
    type PickerSearchMode,
    type PickerSort,
  } from "./lib/picker-search";

  /**
   * The two choices a reader makes about a query, to the right of the box it
   * is typed in: what order the hits come in, and whether the hosts are asked
   * what was said or only the names of things are read. One menu, because a
   * reader who changes one is usually about to change the other, and the
   * header row has room for one control beside the field on a phone.
   */
  interface Props {
    sort: PickerSort;
    mode: PickerSearchMode;
    onSort: (sort: PickerSort) => void;
    onMode: (mode: PickerSearchMode) => void;
    /** Where the menu portals, so it paints above the picker's scrim. */
    portalTarget: HTMLElement | null;
    open?: boolean;
  }
  let { sort, mode, onSort, onMode, portalTarget, open = $bindable(false) }: Props = $props();

  const menuPortalProps = $derived({ to: portalTarget ?? undefined });
  const keywordsOnly = $derived(mode === "keywords");
</script>

<DropdownMenu.Root bind:open>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <!-- The sort chip every list page carries: a quiet ringed chip in the
           chrome rung, muted until hovered or opened. It is a filter, not a
           place, so it does not borrow the project crumb's weight. Tinted
           while the search is narrowed to names: a list that is not searching
           everything says so on its face, not only when opened. -->
      <button
        {...props}
        type="button"
        class="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-workspace-chrome font-normal transition-colors duration-150 hover:bg-[var(--wash-2)] hover:text-foreground max-md:size-11 max-md:justify-center max-md:rounded-[0.625rem] max-md:px-0 max-md:shadow-none {keywordsOnly
          ? 'bg-[color-mix(in_oklch,var(--primary)_13%,transparent)] text-[color:color-mix(in_oklch,var(--primary)_82%,var(--foreground))]'
          : open
            ? 'bg-[var(--wash-2)] text-foreground'
            : 'text-muted-foreground shadow-[inset_0_0_0_.5px_color-mix(in_oklch,var(--foreground)_13%,transparent)]'}"
        aria-label="Sort and search options"
        title="Sort and search options"
      >
        <SortIcon class="size-3.5 shrink-0 opacity-70" />
        <span class="truncate max-md:hidden">{PICKER_SORT_LABELS[sort]}{keywordsOnly ? " · Keywords" : ""}</span>
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
  </DropdownMenu.Content>
</DropdownMenu.Root>

<script lang="ts">
  import { ChevronDown as CaretDownIcon, CircleDashed as CircleDashedIcon } from "@lucide/svelte";
  import * as DropdownMenu from "../dropdown-menu";
  import {
    updateListStatusSelection,
    type ListStatusOption,
  } from "./list-page";
  import { FILTER_CHIP, FILTER_CHIP_OFF, FILTER_CHIP_ON } from "./filter-styles";

  /** The filter bar's lifecycle picker: which statuses the list is showing.
   *
   *  A menu rather than a run of toggle chips, because every list page has five
   *  or six states and that many chips would push the search field out of the
   *  bar. It takes the chips' shape so it still reads as one of them, and takes
   *  their active tint whenever it is hiding something — a list that is not
   *  showing everything must say so on its face, not only when opened.
   *
   *  Selecting nothing is allowed and shows an empty list; that is a legible
   *  state the user asked for, and "Show all" is one click away inside. */
  interface Props {
    options: ListStatusOption[];
    /** The statuses currently shown. */
    selected: string[];
    /** Pages own the change so a status can also widen a fetch (PRs page). */
    onChange: (next: string[]) => void;
    ariaLabel?: string;
    compactText?: boolean;
  }
  let {
    options,
    selected,
    onChange,
    ariaLabel = "Filter by status",
    compactText = false,
  }: Props = $props();

  let open = $state(false);

  const showingAll = $derived(selected.length === options.length);
  const label = $derived.by(() => {
    if (showingAll) return "All statuses";
    if (selected.length === 0) return "No statuses";
    if (selected.length === 1) {
      return options.find((option) => option.value === selected[0])?.label ?? "1 status";
    }
    return `${selected.length} statuses`;
  });

  function setChecked(value: string, checked: boolean) {
    onChange(updateListStatusSelection(options, selected, value, checked));
  }
</script>

<DropdownMenu.Root bind:open>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <button
        {...props}
        type="button"
        class="{FILTER_CHIP} {compactText ? 'text-xs' : ''} {showingAll
          ? FILTER_CHIP_OFF
          : FILTER_CHIP_ON}"
        aria-label={ariaLabel}
      >
        <CircleDashedIcon size={14} class="shrink-0 opacity-75" />
        <span>{label}</span>
        <CaretDownIcon size={9} class="shrink-0 opacity-60" />
      </button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content side="bottom" align="end" sideOffset={6} class="w-[190px]">
    {#each options as option (option.value)}
      <DropdownMenu.CheckboxItem
        checked={selected.includes(option.value)}
        closeOnSelect={false}
        onCheckedChange={(checked) => setChecked(option.value, checked)}
      >
        <span class="flex-1">{option.label}</span>
        <span class="mr-4 text-xs tabular-nums opacity-60">
          {option.count}
        </span>
      </DropdownMenu.CheckboxItem>
    {/each}
    <DropdownMenu.Separator />
    <DropdownMenu.Item
      closeOnSelect={false}
      onSelect={() => onChange(showingAll ? [] : options.map((option) => option.value))}
    >
      {showingAll ? "Show none" : "Show all"}
    </DropdownMenu.Item>
  </DropdownMenu.Content>
</DropdownMenu.Root>

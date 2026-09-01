<script lang="ts">
  import { ChevronDown as CaretDownIcon, X as XIcon } from "@lucide/svelte";
  import ProjectFavicon from "../ProjectFavicon.svelte";
  import * as DropdownMenu from "../dropdown-menu";
  import {
    updateListStatusSelection,
    type ListScopeOption,
  } from "./list-page";
  import {
    FILTER_CHIP_OFF,
    FILTER_CHIP_ON,
    FILTER_CHIP_UNROUNDED,
  } from "./filter-styles";

  /** The cross-project inbox's project narrowing, at the head of the narrowing
   *  row.
   *
   *  Wanting "just these two repos" narrows what the page shows without moving
   *  the page, so it is a filter and reads as one — the crumb keeps saying
   *  `All projects` because the scope of the page has not changed. Empty
   *  selection means every project, which is the resting state; once it is
   *  narrowing it takes the active tint and carries an ✕ that clears it, like
   *  every other filter on the row. */
  interface Props {
    options: ListScopeOption[];
    /** The projects shown, by `ListScopeOption.value`. Empty means all of them. */
    selected: string[];
    onChange: (next: string[]) => void;
    compactText?: boolean;
  }
  let { options, selected, onChange, compactText = false }: Props = $props();

  let open = $state(false);

  const narrowed = $derived(selected.length > 0);
  const label = $derived.by(() => {
    if (!narrowed) return "All projects";
    if (selected.length === 1) {
      return (
        options.find((option) => option.value === selected[0])?.label ??
        "1 project"
      );
    }
    return `${selected.length} projects`;
  });

  function setChecked(value: string, checked: boolean) {
    onChange(updateListStatusSelection(options, selected, value, checked));
  }
</script>

<div class="flex shrink-0 items-center">
  <DropdownMenu.Root bind:open>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <button
          {...props}
          type="button"
          class="{FILTER_CHIP_UNROUNDED} {compactText ? 'text-xs' : ''} {narrowed
            ? `rounded-l-lg pr-1.5! @max-[30rem]/pane:rounded-l-full ${FILTER_CHIP_ON}`
            : `rounded-lg @max-[30rem]/pane:rounded-full ${FILTER_CHIP_OFF}`}"
          aria-label="Filter inbox by project"
        >
          <span>{label}</span>
          <CaretDownIcon size={9} class="shrink-0 opacity-60" />
        </button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content
      side="bottom"
      align="start"
      sideOffset={6}
      class="w-[232px]"
    >
      {#each options as option (option.value)}
        <DropdownMenu.CheckboxItem
          checked={selected.includes(option.value)}
          closeOnSelect={false}
          onCheckedChange={(checked) => setChecked(option.value, checked)}
        >
          <ProjectFavicon projectRoot={option.projectKey} class="size-3.5" />
          <span class="min-w-0 flex-1 truncate">{option.label}</span>
          <span class="mr-4 text-xs tabular-nums opacity-60">
            {option.count}
          </span>
        </DropdownMenu.CheckboxItem>
      {/each}
      {#if options.length === 0}
        <div class="px-2 py-2.5 text-muted-foreground">
          No projects in your inbox.
        </div>
      {/if}
    </DropdownMenu.Content>
  </DropdownMenu.Root>

  {#if narrowed}
    <!-- Clearing is one click from the row rather than a trip back into the
         menu, so a narrowed inbox can always be widened where it is stated. -->
    <button
      type="button"
      class="flex h-7 shrink-0 cursor-pointer items-center rounded-r-lg border-0 bg-[color-mix(in_oklch,var(--primary)_13%,transparent)] pr-2 pl-0.5 text-[color-mix(in_oklch,var(--primary)_82%,var(--foreground))] transition-colors duration-150 hover:text-[color-mix(in_oklch,var(--destructive)_70%,var(--foreground))] @max-[30rem]/pane:h-8 @max-[30rem]/pane:rounded-r-full @max-[30rem]/pane:pr-3"
      aria-label="Show every project"
      title="Show every project"
      onclick={() => onChange([])}
    >
      <XIcon size={12} class="shrink-0 opacity-70" />
    </button>
  {/if}
</div>

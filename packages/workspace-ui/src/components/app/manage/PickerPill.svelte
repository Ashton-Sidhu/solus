<script lang="ts" generics="T extends string">
  import type { Snippet } from "svelte";
  import { ChevronDown as CaretDownIcon } from "@lucide/svelte";
  import * as DropdownMenu from "../../ui/dropdown-menu";
  import { requestInputFocus } from "../../../lib/inputFocus";
  import { FILTER_CHIP_OFF } from "../../ui/list-page/filter-styles";

  /**
   * A pick-one control of a section's bar, in the shape of a chip of the list
   * pages' filter band: a quiet name of what it picks, then the value. The choices open in a menu under it. `value`
   * snippet draws the value when it says more than a label, as the run picker
   * does with the run's state and age.
   */
  let {
    name,
    options,
    selected,
    onSelect,
    disabled = false,
    value,
  }: {
    /** "Workflow", "Run": what the pill picks. */
    name: string;
    options: ReadonlyArray<{ value: T; label: string; detail?: string }>;
    selected: T | null;
    onSelect: (value: T) => void;
    disabled?: boolean;
    value?: Snippet;
  } = $props();

  const selectedLabel = $derived(options.find((option) => option.value === selected)?.label ?? "None");
</script>

<DropdownMenu.Root
  onOpenChange={(next) => {
    if (!next) requestInputFocus();
  }}
>
  <DropdownMenu.Trigger {disabled}>
    {#snippet child({ props })}
      <button
        {...props}
        type="button"
        class="flex h-7 min-w-0 shrink cursor-pointer items-center gap-1.5 overflow-hidden rounded-lg border-0 px-2.5 text-workspace-chrome {FILTER_CHIP_OFF} transition-colors duration-150 hover:bg-[var(--wash-2)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-60 aria-expanded:bg-[var(--wash-2)] pointer-coarse:h-10"
        aria-label="{name}: {selectedLabel}"
      >
        <span class="shrink-0 text-(--solus-text-tertiary)">{name}</span>
        {#if value}
          {@render value()}
        {:else}
          <span class="min-w-0 truncate font-medium text-foreground">{selectedLabel}</span>
        {/if}
        <CaretDownIcon size={9} class="shrink-0 opacity-60" aria-hidden="true" />
      </button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content side="bottom" align="start" sideOffset={6} class="max-h-80 w-[min(22rem,calc(100vw-2rem))] overflow-y-auto">
    <DropdownMenu.RadioGroup value={selected ?? undefined}>
      {#each options as option (option.value)}
        <DropdownMenu.RadioItem value={option.value} onSelect={() => onSelect(option.value)}>
          <span class="min-w-0 flex-1 truncate">{option.label}</span>
          {#if option.detail}
            <span class="shrink-0 text-xs text-(--solus-text-tertiary) tabular-nums">{option.detail}</span>
          {/if}
        </DropdownMenu.RadioItem>
      {/each}
    </DropdownMenu.RadioGroup>
  </DropdownMenu.Content>
</DropdownMenu.Root>

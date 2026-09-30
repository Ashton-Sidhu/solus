<script lang="ts">
  import { ChevronDown as CaretDownIcon } from "@lucide/svelte";
  import { Button } from "../ui/button";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import type { CoverageReading, CoverageReadingId } from "./lib/coverage-readings";

  /**
   * Chooses what the coverage bar under the Trace header shows. A menu in the
   * header rather than a strip of tabs over the bar: the choice is a setting
   * of the card, and the bar keeps the full width for the picture.
   */
  interface Props {
    readings: CoverageReading[];
    active: CoverageReading;
    onSelect: (id: CoverageReadingId) => void;
  }

  let { readings, active, onSelect }: Props = $props();
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <Button
        {...props}
        variant="ghost"
        size="sm"
        class="h-7 shrink-0 gap-1 rounded-md px-2 text-insights-chrome font-normal text-muted-foreground hover:bg-[var(--wash-2)] hover:text-foreground aria-expanded:bg-[var(--wash-2)] aria-expanded:text-foreground pointer-coarse:h-10"
        title="What the bar under the header shows"
        aria-label="Coverage bar: {active.label}"
      >
        {active.label}
        <CaretDownIcon class="size-3 opacity-60" aria-hidden="true" />
      </Button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content align="end" class="min-w-40">
    <DropdownMenu.RadioGroup
      value={active.id}
      onValueChange={(next) => onSelect(next as CoverageReadingId)}
    >
      {#each readings as reading (reading.id)}
        <DropdownMenu.RadioItem value={reading.id}>{reading.label}</DropdownMenu.RadioItem>
      {/each}
    </DropdownMenu.RadioGroup>
  </DropdownMenu.Content>
</DropdownMenu.Root>

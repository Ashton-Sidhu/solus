<script lang="ts">
  /** The size half of a font row: a select the same height as the family
   *  picker beside it, so the two read as one control pair. */
  import * as Select from "../ui/select";
  import { fontSizeOptions } from "./lib/font-sizes";

  interface Props {
    value: number;
    min: number;
    max: number;
    ariaLabel: string;
    onChange: (size: number) => void;
  }

  let { value, min, max, ariaLabel, onChange }: Props = $props();

  const options = $derived(fontSizeOptions(min, max, value));
</script>

<Select.Root
  type="single"
  value={String(value)}
  onValueChange={(next) => {
    const size = Number(next);
    if (Number.isInteger(size)) onChange(size);
  }}
>
  <Select.Trigger
    size="sm"
    aria-label={ariaLabel}
    class="w-20 rounded-[min(var(--radius-md),12px)] text-xs tabular-nums shadow-xs"
  >
    {value} px
  </Select.Trigger>
  <Select.Content align="end" class="max-h-64 min-w-20">
    {#each options as size (size)}
      <Select.Item value={String(size)} label={`${size} px`} />
    {/each}
  </Select.Content>
</Select.Root>

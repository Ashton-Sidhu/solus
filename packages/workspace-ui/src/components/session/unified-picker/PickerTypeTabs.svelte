<script lang="ts">
  import { PICKER_RESULT_LABELS, type PickerResultType } from "./lib/picker-result-types";

  /**
   * The types of result, as tabs under the search box: All, then one tab for
   * each kind. The search's own keys move between them (← →), so the tabs take
   * no focus of their own: the caret stays in the box.
   */
  interface Props {
    types: readonly PickerResultType[];
    value: PickerResultType;
    onChange: (value: PickerResultType) => void;
  }
  let { types, value, onChange }: Props = $props();
</script>

<!-- A narrow window scrolls the strip: every type stays reachable, and the
     arrow keys reach the ones out of view. -->
<div
  class="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]"
  role="tablist"
  aria-label="Result type"
>
  {#each types as type (type)}
    {@const isActive = type === value}
    <button
      type="button"
      role="tab"
      tabindex="-1"
      aria-selected={isActive}
      data-testid="picker-type-tab"
      data-type={type}
      class="h-7 shrink-0 cursor-pointer rounded-lg px-2.5 text-workspace-chrome whitespace-nowrap transition-colors duration-150 pointer-coarse:h-9 pointer-coarse:px-3 {isActive
        ? 'bg-[var(--wash-2)] font-medium text-foreground'
        : 'text-muted-foreground hover:bg-[var(--wash-1)] hover:text-foreground'}"
      onclick={() => onChange(type)}
    >{PICKER_RESULT_LABELS[type]}</button>
  {/each}
</div>

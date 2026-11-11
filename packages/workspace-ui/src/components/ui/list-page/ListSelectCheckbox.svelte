<script lang="ts">
  import type { ListSelection } from "./list-selection.svelte";

  /**
   * A row's selection checkbox. It stays hidden until the row is hovered or
   * focused, and every row shows it while a selection is held. Shift extends
   * the range from the last row toggled.
   */
  interface Props {
    selection: ListSelection;
    id: string;
    /** What a row is, for the screen reader: "task", "notification". */
    noun: string;
    class?: string;
  }
  let { selection, id, noun, class: className = "" }: Props = $props();

  const isSelected = $derived(selection.has(id));
</script>

<button
  type="button"
  class="grid size-4 shrink-0 cursor-pointer place-items-center rounded border-0 text-xs transition-opacity {isSelected
    ? 'bg-primary text-primary-foreground opacity-100'
    : `bg-[var(--wash-3)] text-transparent group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 ${selection.active ? 'opacity-100' : 'opacity-0'}`} {className}"
  onclick={(e) => selection.toggle(id, e)}
  aria-pressed={isSelected}
  aria-label={isSelected ? `Deselect ${noun}` : `Select ${noun}`}
>
  ✓
</button>

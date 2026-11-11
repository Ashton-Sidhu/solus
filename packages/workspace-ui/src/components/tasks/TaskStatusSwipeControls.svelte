<script lang="ts">
  import type { TaskStatusCategory } from "@solus/contracts/task-sources";
  import { CATEGORY_META, TASK_CATEGORIES } from "./lib/tasks-api";
  import TaskStatusGlyph from "./TaskStatusGlyph.svelte";

  /** The controls under a swiped task row: one for each status category. The
   *  host chooses the column of each source for the category. */
  interface Props {
    category: TaskStatusCategory;
    revealed: boolean;
    onSelect: (category: TaskStatusCategory) => void;
    class?: string;
  }

  let { category, revealed, onSelect, class: className = "" }: Props = $props();
</script>

<div class="absolute inset-y-0 right-0 flex {className}" aria-hidden={!revealed}>
  {#each TASK_CATEGORIES as option (option)}
    {@const controlMeta = CATEGORY_META[option]}
    <button
      type="button"
      class="flex w-16 shrink-0 cursor-pointer flex-col items-center justify-center gap-1 border-0 text-xs font-medium transition-transform active:scale-[0.96] [-webkit-tap-highlight-color:transparent]"
      style="background:color-mix(in oklch, var({controlMeta.token}) 18%, var(--background));color:color-mix(in oklch, var({controlMeta.token}) 68%, var(--foreground))"
      tabindex={revealed ? 0 : -1}
      aria-label={`Move to ${controlMeta.label}`}
      aria-pressed={category === option}
      onclick={() => onSelect(option)}
    >
      <TaskStatusGlyph category={option} size={17} />
      {controlMeta.label}
    </button>
  {/each}
</div>

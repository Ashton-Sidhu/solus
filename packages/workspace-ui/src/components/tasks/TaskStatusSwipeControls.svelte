<script lang="ts">
  import type { TaskStatus } from "@solus/contracts/task-types";
  import { BOARD_COLUMNS, STATUS_META } from "./lib/tasks-api";
  import TaskStatusGlyph from "./TaskStatusGlyph.svelte";

  interface Props {
    status: TaskStatus;
    revealed: boolean;
    onSelect: (status: TaskStatus) => void;
    class?: string;
  }

  let { status, revealed, onSelect, class: className = "" }: Props = $props();
</script>

<div class="absolute inset-y-0 right-0 flex {className}" aria-hidden={!revealed}>
  {#each BOARD_COLUMNS as column (column.status)}
    {@const controlMeta = STATUS_META[column.status]}
    <button
      type="button"
      class="flex w-16 shrink-0 cursor-pointer flex-col items-center justify-center gap-1 border-0 text-xs font-medium transition-transform active:scale-[0.96] [-webkit-tap-highlight-color:transparent]"
      style="background:color-mix(in oklch, var({controlMeta.token}) 18%, var(--background));color:color-mix(in oklch, var({controlMeta.token}) 68%, var(--foreground))"
      tabindex={revealed ? 0 : -1}
      aria-label={`Set status to ${column.label}`}
      aria-pressed={status === column.status}
      onclick={() => onSelect(column.status)}
    >
      <TaskStatusGlyph status={column.status} size={17} />
      {column.label === "In progress" ? "Doing" : column.label === "In review" ? "Review" : column.label}
    </button>
  {/each}
</div>

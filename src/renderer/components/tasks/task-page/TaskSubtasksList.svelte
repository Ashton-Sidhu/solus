<script lang="ts">
  import { ArrowRightIcon } from "phosphor-svelte";
  import type { Task } from "../../../../shared/task-types";
  import TaskStatusGlyph from "../TaskStatusGlyph.svelte";
  import { taskSubtaskRow } from "./lib/task-page";

  interface Props {
    subtasks: Task[];
    sessionsFor: (taskId: string) => number;
    onOpen: (taskId: string) => void;
  }

  let { subtasks, sessionsFor, onOpen }: Props = $props();

  const rows = $derived(
    subtasks.map((task) => taskSubtaskRow(task, sessionsFor(task.id))),
  );
</script>

<div class="flex flex-col gap-[7px] pt-[26px]">
  <div class="flex items-center gap-2.5">
    <span class="text-xs font-normal text-muted-foreground uppercase">
      Subtasks
    </span>
    <span class="font-mono text-xs tabular-nums text-muted-foreground opacity-70">
      {rows.length}
    </span>
    <span class="h-px flex-1 bg-[var(--hairline)]" aria-hidden="true"></span>
  </div>

  <div
    class="max-h-[min(22rem,42vh)] overflow-y-auto overscroll-contain rounded-xl bg-card shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_10%,transparent)] [scrollbar-width:thin]"
  >
    {#each rows as row, index (row.task.id)}
      <button
        type="button"
        class="group flex w-full cursor-pointer items-center gap-[11px] py-2.5 pr-2.5 pl-[13px] text-left transition-colors hover:bg-[var(--wash-1)] focus-visible:bg-[var(--wash-1)] focus-visible:outline-none {index
          ? 'border-t-[.5px] border-[var(--hairline)]'
          : ''}"
        onclick={() => onOpen(row.task.id)}
        aria-label={`Open subtask ${row.task.title}`}
      >
        <TaskStatusGlyph status={row.task.status} size={14} />
        <span class="flex min-w-0 flex-1 flex-col gap-[3px]">
          <span class="truncate text-[0.8125rem] font-medium">
            {row.task.title}
          </span>
          <span class="flex min-w-0 items-center gap-[7px] text-xs text-muted-foreground opacity-70">
            <span class="shrink-0">{row.statusLabel}</span>
            <span class="opacity-50" aria-hidden="true">·</span>
            <span class="truncate">{row.sessionLabel}</span>
          </span>
        </span>
        <ArrowRightIcon
          size={14}
          class="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
          aria-hidden="true"
        />
      </button>
    {/each}
  </div>
</div>

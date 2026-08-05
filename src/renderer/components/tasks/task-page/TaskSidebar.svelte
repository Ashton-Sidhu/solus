<script lang="ts">
  import type {
    Task,
    TaskPriority,
    TaskStatus,
    TaskUpdatePatch,
  } from "../../../../shared/task-types";
  import * as DropdownMenu from "../../ui/dropdown-menu";
  import { authorInitials, PRIORITY_META, relativeTime, STATUS_META } from "../lib/tasks-api";
  import { priorityBars, priorityLabel, statusTextColor } from "./lib/task-page";

  interface Props {
    task: Task;
    projectLabel: string;
    canEdit: boolean;
    canEditPlanningFields: boolean;
    onSave: (patch: TaskUpdatePatch) => void;
  }

  let { task, projectLabel, canEdit, canEditPlanningFields, onSave }: Props = $props();

  const STATUS_OPTIONS: TaskStatus[] = [
    "inbox",
    "todo",
    "in_progress",
    "in_review",
    "done",
    "dropped",
  ];
  const PRIORITY_OPTIONS: TaskPriority[] = ["urgent", "high", "medium", "low"];

  const status = $derived(STATUS_META[task.status]);
  const bars = $derived(priorityBars(task.priority));
  const branches = $derived(task.branch ? [task.branch] : []);

  let labelDraft = $state("");

  const ROW = "flex h-[34px] items-center";
  const ROW_LABEL = "w-[78px] shrink-0 pl-0.5 text-[12px] text-muted-foreground";
  const VALUE_BTN =
    "flex h-[34px] flex-1 cursor-pointer items-center gap-2 rounded-md px-2 text-[13px] hover:bg-[var(--wash-2)]";
  const GROUP = "flex flex-col gap-1 px-3.5 pt-[15px] pb-4";

  function addLabel() {
    const next = labelDraft
      .split(",")
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => !task.labels.includes(l));
    labelDraft = "";
    if (next.length) onSave({ labels: [...task.labels, ...next] });
  }

  function removeLabel(label: string) {
    onSave({ labels: task.labels.filter((l) => l !== label) });
  }
</script>

<div
  class="sticky top-0 flex w-[308px] shrink-0 flex-col rounded-[14px] bg-card shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_11%,transparent),0_1px_2px_-1px_rgba(0,0,0,.05),0_12px_28px_-12px_rgba(0,0,0,.14)]"
>
  <div class={GROUP}>
    <div class={ROW}>
      <span class={ROW_LABEL}>Status</span>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger disabled={!canEdit} class={VALUE_BTN}>
          <svg
            width="12"
            height="12"
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            stroke-width="1.45"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="shrink-0"
            style="color:{statusTextColor(task.status)}"
            aria-hidden="true"><path d={status.glyph} /></svg
          >
          {status.label}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="end" class="w-[182px]">
          {#each STATUS_OPTIONS as option (option)}
            {@const meta = STATUS_META[option]}
            <DropdownMenu.Item onSelect={() => onSave({ status: option })}>
              <svg
                width="12"
                height="12"
                viewBox="0 0 14 14"
                fill="none"
                stroke="currentColor"
                stroke-width="1.45"
                stroke-linecap="round"
                stroke-linejoin="round"
                class="shrink-0"
                style="color:{statusTextColor(option)}"
                aria-hidden="true"><path d={meta.glyph} /></svg
              >
              {meta.label}
              {#if option === task.status}
                <span class="ml-auto text-primary" aria-hidden="true">✓</span>
              {/if}
            </DropdownMenu.Item>
          {/each}
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </div>

    <div class={ROW}>
      <span class={ROW_LABEL}>Priority</span>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger disabled={!canEditPlanningFields} class={VALUE_BTN}>
          <span class="flex h-[9px] shrink-0 items-end gap-[1.5px]" aria-hidden="true">
            {#each bars as bar (bar.height)}
              <span
                class="w-[2.5px] rounded-[1px]"
                style="height:{bar.height};background:{bar.background}"
              ></span>
            {/each}
          </span>
          {priorityLabel(task.priority)}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="end" class="w-[182px]">
          {#each PRIORITY_OPTIONS as option (option)}
            <DropdownMenu.Item onSelect={() => onSave({ priority: option })}>
              {PRIORITY_META[option].label}
              {#if option === task.priority}
                <span class="ml-auto text-primary" aria-hidden="true">✓</span>
              {/if}
            </DropdownMenu.Item>
          {/each}
          <DropdownMenu.Item onSelect={() => onSave({ priority: null })}>
            No priority
            {#if !task.priority}
              <span class="ml-auto text-primary" aria-hidden="true">✓</span>
            {/if}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </div>

    <div class={ROW}>
      <span class={ROW_LABEL}>Assignee</span>
      {#if task.assignee}
        <span class="flex h-[34px] flex-1 items-center gap-2 px-2 text-[13px]">
          <span
            class="flex size-[18px] shrink-0 items-center justify-center rounded-full text-[9px] font-medium shadow-[inset_0_0_0_.5px_color-mix(in_oklch,var(--foreground)_10%,transparent)]"
            style="background:color-mix(in oklch, var(--chart-1) 22%, transparent);color:color-mix(in oklch, var(--chart-1) 72%, var(--foreground))"
          >
            {authorInitials(task.assignee)}
          </span>
          {task.assignee}
        </span>
      {:else}
        <span class="flex h-[34px] flex-1 items-center px-2 text-[13px] text-muted-foreground">
          Unassigned
        </span>
      {/if}
    </div>

    <div class={ROW}>
      <span class={ROW_LABEL}>Project</span>
      <span class="flex h-[34px] min-w-0 flex-1 items-center gap-2 px-2 text-[13px]">
        <span
          class="size-3 shrink-0 rounded bg-[color-mix(in_oklch,var(--chart-4)_55%,transparent)]"
          aria-hidden="true"
        ></span>
        <span class="truncate">{projectLabel}</span>
      </span>
    </div>

    <div class="flex min-h-[34px] items-start">
      <span class="{ROW_LABEL} leading-[34px]">Labels</span>
      <span class="flex min-w-0 flex-1 flex-wrap items-center gap-1 pt-1 pl-2">
        {#each task.labels as label (label)}
          <span
            class="inline-flex h-[19px] items-center gap-1 rounded-full px-1.5 text-[11px] font-[450] tracking-[.02em] text-muted-foreground shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_13%,transparent)]"
          >
            {label}
            {#if canEdit}
              <button
                type="button"
                class="cursor-pointer opacity-60 hover:opacity-100"
                onclick={() => removeLabel(label)}
                aria-label="Remove label {label}"
              >
                ×
              </button>
            {/if}
          </span>
        {/each}
        {#if canEdit}
          <input
            class="h-[19px] min-w-[60px] flex-1 bg-transparent text-[11px] text-muted-foreground outline-none placeholder:text-muted-foreground/70"
            bind:value={labelDraft}
            placeholder="Add a label…"
            onblur={addLabel}
            onkeydown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addLabel();
              }
            }}
          />
        {/if}
      </span>
    </div>

    <div class={ROW}>
      <span class={ROW_LABEL}>Target</span>
      {#if canEditPlanningFields}
        <input
          type="date"
          class="h-[34px] flex-1 cursor-pointer rounded-md bg-transparent px-2 font-mono text-[12px] text-muted-foreground outline-none hover:bg-[var(--wash-2)] hover:text-foreground"
          value={task.dueDate ?? ""}
          onchange={(e) => onSave({ dueDate: e.currentTarget.value || null })}
          aria-label="Target date"
        />
      {:else}
        <span class="flex h-[34px] flex-1 items-center px-2 font-mono text-[12px] text-muted-foreground">
          {task.dueDate ?? "None"}
        </span>
      {/if}
    </div>
  </div>

  {#if branches.length}
    <div class="{GROUP} gap-[11px] border-t-[.5px] border-[var(--hairline)]">
      <span
        class="pl-0.5 text-[10px] font-[450] tracking-[.09em] text-muted-foreground uppercase"
      >
        Work
      </span>
      <div class="flex items-start">
        <span class="{ROW_LABEL} leading-[34px]">
          {branches.length > 1 ? "Branches" : "Branch"}
        </span>
        <span class="flex min-w-0 flex-1 flex-col gap-px py-[3px]">
          {#each branches as branch (branch)}
            <span
              class="flex h-7 items-center rounded-md px-2 font-mono text-[12px] text-muted-foreground"
            >
              <span class="min-w-0 truncate">{branch}</span>
            </span>
          {/each}
        </span>
      </div>
    </div>
  {/if}

  <div
    class="flex items-center gap-2 border-t-[.5px] border-[var(--hairline)] px-4 pt-[13px] pb-3.5"
  >
    <span class="text-[12px] text-muted-foreground opacity-80">Created</span>
    <span class="font-mono text-[11px] text-muted-foreground opacity-65">
      {task.createdAt ? relativeTime(task.createdAt) : "—"}
    </span>
    <span class="flex-1"></span>
    <span class="text-[12px] text-muted-foreground opacity-80">Updated</span>
    <span class="font-mono text-[11px] text-muted-foreground opacity-65">
      {relativeTime(task.updatedAt)}
    </span>
  </div>
</div>

<script lang="ts">
  import {
    ChevronDown as CaretDownIcon,
    Clock as ClockIcon,
    Ellipsis as MoreIcon,
    ExternalLink as ArrowSquareOutIcon,
    ListChecks as ListChecksIcon,
    Moon as MoonIcon,
    Sun as SunIcon,
  } from "@lucide/svelte";
  import type { Task, TaskStatus } from "@solus/contracts/task-types";
  import { getSessionSidebarStore, getWorkspaceContext } from "../../../contexts";
  import { toasts } from "../../../lib/toasts";
  import * as DropdownMenu from "../../ui/dropdown-menu";
  import TaskStatusGlyph from "../../tasks/TaskStatusGlyph.svelte";
  import { TASK_SNOOZE_CHOICES, taskSnoozeUntil } from "../lib/task-snooze";
  import { STATUS_META, TASK_STATUSES } from "../../tasks/lib/tasks-api";

  /**
   * The row of things you can do to the previewed task without opening it.
   *
   * Status and snooze are edits to a row you are still choosing between, so
   * they run here and leave the picker open. The two buttons on the right
   * navigate; the parent owns them because they close the picker, and it
   * names them, so the same bar serves a task ("Resume latest") and a session
   * ("Resume") without knowing which it is under.
   */
  interface Props {
    task: Task;
    /** Where the dropdowns portal, so they paint above the picker's scrim. */
    portalTarget: HTMLElement | null;
    /** What ⏎ does. */
    primaryLabel: string;
    onPrimary: () => void;
    secondaryLabel?: string;
    onSecondary?: () => void;
    onOpenTask: (task: Task) => void;
    onOpenSource: (task: Task) => void;
  }
  let {
    task,
    portalTarget,
    primaryLabel,
    onPrimary,
    secondaryLabel,
    onSecondary,
    onOpenTask,
    onOpenSource,
  }: Props = $props();

  const session = getWorkspaceContext();
  const sidebarStore = getSessionSidebarStore();

  const status = $derived(STATUS_META[task.status]);
  const isSnoozed = $derived(sidebarStore.snoozedTasks.some((row) => row.taskId === task.id));
  const menuPortalProps = $derived({ to: portalTarget ?? undefined });

  async function setStatus(next: TaskStatus): Promise<void> {
    try {
      await session.tasksStore.get(task.id, task.projectKey ?? undefined).setStatus(next);
    } catch (error) {
      toasts.error("Couldn't update status", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }
</script>

<!-- Desktop reads left to right: edit the row, then leave it. A thumb gets the
     leaving buttons first at 50px, and the edits as chips on a second line. -->
<div class="flex flex-wrap items-center gap-1.5 max-md:gap-[9px]">
  <DropdownMenu.Root>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <button
          {...props}
          type="button"
          class="flex h-[30px] cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-workspace-chrome font-medium text-muted-foreground transition-[background-color,color] duration-100 hover:bg-[var(--wash-2)] hover:text-foreground max-md:order-5 max-md:h-11 max-md:bg-[var(--wash-2)] max-md:px-3.5"
          aria-label="Set task status"
        >
          <TaskStatusGlyph status={task.status} size={13} />
          {status.label}
          <CaretDownIcon size={9} class="shrink-0 opacity-60" />
        </button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content side="top" align="start" sideOffset={6} class="min-w-40" portalProps={menuPortalProps}>
      {#each TASK_STATUSES as option (option)}
        <DropdownMenu.Item onSelect={() => void setStatus(option)}>
          <TaskStatusGlyph status={option} size={13} />
          {STATUS_META[option].label}
        </DropdownMenu.Item>
      {/each}
    </DropdownMenu.Content>
  </DropdownMenu.Root>

  {#if isSnoozed}
    <button
      type="button"
      class="flex size-[26px] cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-[background-color,color] duration-100 hover:bg-[var(--wash-2)] hover:text-foreground max-md:order-5 max-md:size-11 max-md:bg-[var(--wash-2)]"
      aria-label="Wake task now"
      title="Wake now"
      onclick={() => sidebarStore.snoozeRow(task.id, null)}
    >
      <SunIcon size={13} class="shrink-0" />
    </button>
  {:else}
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          <button
            {...props}
            type="button"
            class="flex size-[26px] cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-[background-color,color] duration-100 hover:bg-[var(--wash-2)] hover:text-foreground max-md:order-5 max-md:size-11 max-md:bg-[var(--wash-2)]"
            aria-label="Snooze task"
            title="Snooze"
          >
            <ClockIcon size={13} class="shrink-0" />
          </button>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content side="top" align="start" sideOffset={6} class="min-w-40" portalProps={menuPortalProps}>
        {#each TASK_SNOOZE_CHOICES as choice (choice.preset)}
          {@const ChoiceIcon = choice.isRelative ? ClockIcon : MoonIcon}
          <DropdownMenu.Item onSelect={() => sidebarStore.snoozeRow(task.id, taskSnoozeUntil(choice.preset))}>
            <ChoiceIcon size={13} class="shrink-0 opacity-70" />
            {choice.label}
          </DropdownMenu.Item>
        {/each}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  {/if}

  <DropdownMenu.Root>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <button
          {...props}
          type="button"
          class="flex size-[26px] cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-[background-color,color] duration-100 hover:bg-[var(--wash-2)] hover:text-foreground max-md:order-3 max-md:size-[50px] max-md:rounded-lg max-md:bg-[var(--wash-2)] max-md:text-foreground"
          aria-label="More actions"
        >
          <MoreIcon size={14} class="shrink-0" />
        </button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content side="top" align="start" sideOffset={6} class="min-w-40" portalProps={menuPortalProps}>
      <DropdownMenu.Item onSelect={() => onOpenTask(task)}>
        <ListChecksIcon size={13} class="shrink-0 opacity-70" />
        Open task
      </DropdownMenu.Item>
      {#if task.url}
        <DropdownMenu.Item onSelect={() => onOpenSource(task)}>
          <ArrowSquareOutIcon size={13} class="shrink-0 opacity-70" />
          Source ticket
        </DropdownMenu.Item>
      {/if}
    </DropdownMenu.Content>
  </DropdownMenu.Root>

  <!-- Desktop: the gap that pushes the leaving buttons to the right edge.
       Phone: a full-width break between the row you leave by and the chips you
       edit with, so the primary keeps a whole line and its label never wraps.
       Both are the same element because both are the same idea — the seam. -->
  <span class="flex-1 max-md:order-4 max-md:h-0 max-md:basis-full" aria-hidden="true"></span>

  {#if secondaryLabel && onSecondary}
    <button
      type="button"
      class="flex h-[30px] cursor-pointer items-center rounded-lg bg-card px-[13px] text-workspace-chrome font-medium text-foreground shadow-[shadow:0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_13%,transparent)] transition-[background-color,scale] duration-150 hover:bg-[var(--wash-2)] active:scale-[0.97] max-md:order-2 max-md:h-[50px] max-md:bg-[var(--wash-2)] max-md:px-4 max-md:shadow-none"
      onclick={onSecondary}
    >{secondaryLabel}</button>
  {/if}
  <button
    type="button"
    class="flex h-[30px] cursor-pointer items-center gap-2 rounded-lg bg-primary pr-[11px] pl-[13px] text-workspace-chrome font-medium text-primary-foreground shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-[filter,scale] duration-150 hover:brightness-105 active:scale-[0.97] max-md:order-1 max-md:h-[50px] max-md:flex-1 max-md:justify-center max-md:font-semibold"
    onclick={onPrimary}
  >
    {primaryLabel}
    <span class="font-mono text-micro leading-none opacity-80 max-md:hidden" aria-hidden="true">⏎</span>
  </button>
</div>

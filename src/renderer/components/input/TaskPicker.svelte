<script lang="ts">
  import {
    CheckIcon,
    PlusIcon,
    XIcon,
  } from "phosphor-svelte";
  import { mergeProps } from "bits-ui";
  import { getWorkspaceContext } from "../../contexts";
  import type { TaskTarget } from "../../../shared/types";
  import * as Command from "../ui/command";
  import { Button } from "../ui/button";
  import { MenuFooter, MenuSearch } from "../ui/menu";
  import * as Popover from "../ui/popover";
  import * as TooltipUI from "@renderer/components/ui/tooltip";
  import RoundedTaskIcon from "./RoundedTaskIcon.svelte";

  interface Props {
    /** Where the session this composer starts will be filed. */
    task: TaskTarget;
    projectKey: string;
    onSelect: (task: TaskTarget) => void;
    /** Return focus to the composer once the menu closes. */
    onDismiss: () => void;
  }

  let { task: target, projectKey, onSelect, onDismiss }: Props = $props();

  const workspace = getWorkspaceContext();
  const selectedTask = $derived(
    target.kind === "existing"
      ? (workspace.tasksStore.tasks.find((task) => task.id === target.taskId) ??
        null)
      : null,
  );
  const tasks = $derived(
    workspace.tasksStore
      .tasksForProject(projectKey)
      .filter(
        (task) =>
          task.kind === "task" &&
          task.status !== "done" &&
          task.status !== "dropped",
      ),
  );
  const label = $derived(
    selectedTask?.title ?? (target.kind === "none" ? "No task" : "New task"),
  );

  let open = $state(false);
  let tooltipOpen = $state(false);
  let query = $state("");
  let triggerEl = $state<HTMLButtonElement | null>(null);

  function handleOpenChange(next: boolean) {
    open = next;
    if (next) {
      tooltipOpen = false;
      query = "";
      void workspace.tasksStore.ensureLoaded();
    } else {
      onDismiss();
    }
  }

  function select(next: TaskTarget) {
    onSelect(next);
    open = false;
  }

  function getTooltipOpen() {
    return tooltipOpen && !open;
  }

  function setTooltipOpen(next: boolean) {
    tooltipOpen = next && !open;
  }
</script>

<Popover.Root bind:open onOpenChange={handleOpenChange}>
  <Popover.Trigger>
    {#snippet child({ props })}
      <TooltipUI.Root
        bind:open={getTooltipOpen, setTooltipOpen}
        disabled={open}
      >
        <TooltipUI.Trigger>
          {#snippet child({ props: tooltipProps })}
            <Button
              {...mergeProps(tooltipProps, props)}
              bind:ref={triggerEl}
              variant="ghost"
              class="group relative h-auto min-w-0 shrink gap-1.5 rounded-lg px-2 py-1 text-[0.8125rem] font-normal transition-[background-color,color,scale] duration-[var(--duration-quick)] ease-(--ease-premium) active:scale-[0.96] focus-visible:outline-none focus-visible:ring-0 after:absolute after:left-0 after:top-1/2 after:h-10 after:w-full after:-translate-y-1/2 after:content-[''] {open
 ? 'bg-(--solus-surface-hover) text-(--solus-text-primary)'
 : 'text-(--solus-text-tertiary) hover:bg-[color-mix(in_srgb,var(--solus-surface-hover)_60%,transparent)] hover:text-(--solus-text-secondary) focus-visible:bg-(--solus-surface-hover) focus-visible:text-(--solus-text-secondary)'}"
              style="max-width:12rem"
            >
              <RoundedTaskIcon
                size={14}
                class="shrink-0 text-(--solus-text-tertiary) transition-opacity duration-[var(--duration-quick)] group-hover:opacity-100 {open
 ? 'opacity-100'
 : 'opacity-70'}"
              />
              <span class="truncate">{label}</span>
            </Button>
          {/snippet}
        </TooltipUI.Trigger>
        <TooltipUI.Content value="Choose the task for this chat" />
      </TooltipUI.Root>
    {/snippet}
  </Popover.Trigger>

  <Popover.Content
    data-solus-ui
    customAnchor={triggerEl}
    side="top"
    align="start"
    sideOffset={6}
    collisionPadding={8}
    class="menu-surface z-[10002] w-[320px] gap-0 rounded-2xl bg-(--solus-menu-bg) p-0 text-menu shadow-[shadow:var(--solus-menu-shadow)] ring-0 lg:text-menu"
  >
    <Command.Root>
      <MenuSearch bind:value={query} placeholder="Search tasks" />
      <Command.List class="max-h-[288px] overflow-y-auto p-1.5">
        <Command.Item
          value="new task create"
          onSelect={() => select({ kind: "new" })}
          data-menu-current={target.kind === "new"
            ? ""
            : undefined}
        >
          <PlusIcon size={13} class="shrink-0 text-(--solus-text-tertiary)" />
          <span class="min-w-0 flex-1 truncate">New task</span>
          {#if target.kind === "new"}
            <CheckIcon size={12} class="shrink-0 text-(--solus-accent)" />
          {/if}
        </Command.Item>
        <Command.Item
          value="no task without task"
          onSelect={() => select({ kind: "none" })}
          data-menu-current={target.kind === "none" ? "" : undefined}
        >
          <XIcon size={13} class="shrink-0 text-(--solus-text-tertiary)" />
          <span class="min-w-0 flex-1 truncate">No task</span>
          {#if target.kind === "none"}
            <CheckIcon size={12} class="shrink-0 text-(--solus-accent)" />
          {/if}
        </Command.Item>

        <div class="mx-1 my-1.5 h-px bg-(--solus-menu-hairline)"></div>

        <Command.Empty class="px-2.5 py-3 text-center text-xs text-(--solus-text-tertiary)">
          No tasks match
        </Command.Empty>
        <Command.Group heading="Open tasks">
          {#each tasks as task (task.id)}
            <Command.Item
              value="{task.title} {task.shortId ?? ''} {task.id}"
              onSelect={() => select({ kind: "existing", taskId: task.id })}
              data-menu-current={selectedTask?.id === task.id
                ? ""
                : undefined}
              class="menu-item-stagger"
            >
              <RoundedTaskIcon
                size={13}
                class="shrink-0 text-(--solus-text-tertiary)"
              />
              <span class="min-w-0 flex-1 truncate">{task.title}</span>
              {#if selectedTask?.id === task.id}
                <CheckIcon size={12} class="shrink-0 text-(--solus-accent)" />
              {/if}
            </Command.Item>
          {/each}
        </Command.Group>
      </Command.List>
    </Command.Root>
    <MenuFooter hints={[["⏎", "select"]]} summary="{tasks.length} tasks" />
  </Popover.Content>
</Popover.Root>

<script lang="ts">
  import { Check as CheckIcon, X as XIcon } from "@lucide/svelte";
  import { mergeProps } from "bits-ui";
  import { getWorkspaceContext } from "../../contexts";
  import type { TaskTarget } from "@solus/contracts/types";
  import { comboHint } from "../../lib/keybindings/manifest";
  import * as Command from "../ui/command";
  import { Button } from "../ui/button";
  import { MenuSearch } from "../ui/menu";
  import * as Popover from "../ui/popover";
  import * as TooltipUI from "@solus/workspace-ui/components/ui/tooltip";
  import { taskPickerSections } from "../tasks/lib/task-picker-sections";
  import { taskRef } from "../tasks/lib/tasks-api";
  import {
    ProviderTaskSearch,
    tasksOnlyFound,
  } from "../../lib/provider-task-search.svelte";
  import TaskIcon from "../ui/TaskIcon.svelte";

  interface Props {
    /** Where the session this composer starts will be filed. */
    task: TaskTarget;
    onSelect: (task: TaskTarget) => void;
    /** Return focus to the composer once the menu closes. */
    onDismiss: () => void;
    /** The pane this chip sits in, so it answers only the open shortcut aimed at
     *  that composer. Unset for the workspace dock, which has no pane. */
    paneId?: string;
  }

  let { task: target, onSelect, onDismiss, paneId }: Props = $props();

  const workspace = getWorkspaceContext();
  const selectedTask = $derived(
    target.kind === "existing" ? workspace.tasksStore.peek(target.taskId) : null,
  );
  const tasks = $derived(
    workspace.tasksStore.tasks.filter((task) => task.category !== "done"),
  );
  const taskSections = $derived(taskPickerSections(tasks));
  // The host lists at most a part of a large task source. A query also asks
  // the provider, and the tasks only it found show below the listed ones.
  const providerSearch = new ProviderTaskSearch((text) => workspace.tasksStore.search(text));
  const foundTasks = $derived(tasksOnlyFound(providerSearch.results, tasks));
  const label = $derived(
    selectedTask?.title ?? "No task",
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
    }
  }

  function handleCloseAutoFocus(event: Event) {
    event.preventDefault();
    onDismiss();
  }

  function select(next: TaskTarget) {
    onSelect(next);
    open = false;
  }

  $effect(() => {
    if (!open) return;
    providerSearch.request(query);
    return () => providerSearch.cancel();
  });

  // The open shortcut is dispatched by the composer this chip sits under and
  // names its pane. Only the chip in that pane answers, and only while it is on
  // screen — the visibility test drops the mirror a hidden layout keeps mounted,
  // so the same keystroke never opens a menu off-screen.
  $effect(() => {
    const handler = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : undefined;
      if ((detail?.paneId ?? null) !== (paneId ?? null)) return;
      if (triggerEl && triggerEl.offsetParent === null) return;
      handleOpenChange(!open);
    };
    window.addEventListener("solus:toggle-session-task-picker", handler);
    return () =>
      window.removeEventListener("solus:toggle-session-task-picker", handler);
  });

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
              aria-label={selectedTask ? `Choose task: ${label}` : "Link to task"}
              class="group flex size-[1.875rem] shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-[background,color] duration-150 hover:bg-accent hover:text-foreground {open ? 'bg-accent text-foreground' : ''}"
            >
              <TaskIcon
                size={16}
                class="shrink-0 text-(--solus-text-tertiary) transition-opacity duration-[var(--duration-quick)] group-hover:opacity-100 {open
 ? 'opacity-100'
 : 'opacity-70'}"
              />
            </Button>
          {/snippet}
        </TooltipUI.Trigger>
        <TooltipUI.Content
          value={{
            label: selectedTask ? `Choose task: ${label}` : "Link to task",
            shortcut: comboHint("global.session-task-picker"),
          }}
        />
      </TooltipUI.Root>
    {/snippet}
  </Popover.Trigger>

  <Popover.Content
    data-solus-ui
    customAnchor={triggerEl}
    side="bottom"
    align="end"
    sideOffset={6}
    collisionPadding={8}
    onCloseAutoFocus={handleCloseAutoFocus}
    class="menu-surface z-[10002] w-[320px] gap-0 rounded-2xl bg-(--solus-menu-bg) p-0 text-workspace-chrome shadow-[shadow:var(--solus-menu-shadow)] ring-0 lg:text-workspace-chrome [&_.menu-row]:text-workspace-chrome [&_[data-slot=command-input]]:text-workspace-chrome"
  >
    <Command.Root>
      <MenuSearch bind:value={query} placeholder="Search tasks" />
      <Command.List class="max-h-[288px] overflow-y-auto p-1.5">
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

        {#if !providerSearch.searching && foundTasks.length === 0}
          <Command.Empty class="px-2.5 py-3 text-center text-xs text-(--solus-text-tertiary)">
            No tasks match
          </Command.Empty>
        {/if}
        {#each taskSections as section (section.key)}
          <Command.Group heading={section.label}>
            {#each section.tasks as task (task.id)}
              <Command.Item
                value="{task.title} {task.reference ?? ''} {task.id}"
                onSelect={() => select({ kind: "existing", taskId: task.id })}
                data-menu-current={selectedTask?.id === task.id
                  ? ""
                  : undefined}
                class="menu-item-stagger"
              >
                <TaskIcon
                  size={13}
                  class="shrink-0 text-(--solus-text-tertiary)"
                />
                <span class="min-w-0 flex-1 truncate">{task.title}</span>
                <span class="shrink-0 text-(--solus-text-tertiary)">{taskRef(task)}</span>
                {#if selectedTask?.id === task.id}
                  <CheckIcon size={12} class="shrink-0 text-(--solus-accent)" />
                {/if}
              </Command.Item>
            {/each}
          </Command.Group>
        {/each}
        <!-- The provider matched these itself, so the menu's own filter must
             not hide them. -->
        {#if foundTasks.length}
          <Command.Group heading="More results" forceMount>
            {#each foundTasks as task (task.id)}
              <Command.Item
                value="found {task.id}"
                forceMount
                onSelect={() => select({ kind: "existing", taskId: task.id })}
              >
                <TaskIcon
                  size={13}
                  class="shrink-0 text-(--solus-text-tertiary)"
                />
                <span class="min-w-0 flex-1 truncate">{task.title}</span>
                <span class="shrink-0 text-(--solus-text-tertiary)">{taskRef(task)}</span>
              </Command.Item>
            {/each}
          </Command.Group>
        {/if}
        {#if providerSearch.searching}
          <p class="px-2.5 py-2 text-xs text-(--solus-text-tertiary)">Searching…</p>
        {:else if providerSearch.error}
          <p class="px-2.5 py-2 text-xs text-(--failure)">{providerSearch.error}</p>
        {/if}
      </Command.List>
    </Command.Root>
  </Popover.Content>
</Popover.Root>

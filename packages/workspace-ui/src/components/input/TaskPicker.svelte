<script lang="ts">
  import { Check as CheckIcon, Plus as PlusIcon, X as XIcon } from "@lucide/svelte";
  import { mergeProps } from "bits-ui";
  import { getWorkspaceContext } from "../../contexts";
  import type { TaskTarget } from "@solus/contracts/types";
  import { comboHint } from "../../lib/keybindings/manifest";
  import * as Command from "../ui/command";
  import { Button } from "../ui/button";
  import { MenuFooter, MenuSearch } from "../ui/menu";
  import * as Popover from "../ui/popover";
  import * as TooltipUI from "@solus/workspace-ui/components/ui/tooltip";
  import { taskPickerSections } from "../tasks/lib/task-picker-sections";
  import RoundedTaskIcon from "./RoundedTaskIcon.svelte";

  interface Props {
    /** Where the session this composer starts will be filed. */
    task: TaskTarget;
    projectKey: string;
    onSelect: (task: TaskTarget) => void;
    /** Return focus to the composer once the menu closes. */
    onDismiss: () => void;
    /** The pane this chip sits in, so it answers only the open shortcut aimed at
     *  that composer. Unset for the workspace dock, which has no pane. */
    paneId?: string;
  }

  let { task: target, projectKey, onSelect, onDismiss, paneId }: Props = $props();

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
  const taskSections = $derived(taskPickerSections(tasks));
  const label = $derived(
    selectedTask?.title ?? (target.kind === "none" ? "No task" : "New task"),
  );

  let open = $state(false);
  let tooltipOpen = $state(false);
  let query = $state("");
  let promotingId = $state<string | null>(null);
  let promotionError = $state<string | null>(null);
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

  async function selectTask(task: (typeof tasks)[number]) {
    promotionError = null;
    if (task.providerId === "local") {
      select({ kind: "existing", taskId: task.id });
      return;
    }
    promotingId = task.id;
    try {
      const nativeTask = await workspace.tasksStore
        .get(task.id, task.projectKey ?? undefined)
        .promote();
      select({ kind: "existing", taskId: nativeTask.id });
    } catch (error) {
      promotionError = error instanceof Error ? error.message : String(error);
    } finally {
      promotingId = null;
    }
  }

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
              class="group relative h-auto min-w-0 shrink gap-1.5 rounded-lg px-2 py-1 text-workspace-chrome font-normal transition-[background-color,color,scale] duration-[var(--duration-quick)] ease-(--ease-premium) active:scale-[0.96] focus-visible:outline-none focus-visible:ring-0 after:absolute after:left-0 after:top-1/2 after:h-10 after:w-full after:-translate-y-1/2 after:content-[''] {open
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
        <TooltipUI.Content
          value={{
            label: "Choose the task for this chat",
            shortcut: comboHint("global.session-task-picker"),
          }}
        />
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
    onCloseAutoFocus={handleCloseAutoFocus}
    class="menu-surface z-[10002] w-[320px] gap-0 rounded-2xl bg-(--solus-menu-bg) p-0 text-workspace-chrome shadow-[shadow:var(--solus-menu-shadow)] ring-0 lg:text-workspace-chrome [&_.menu-row]:text-workspace-chrome [&_[data-slot=command-input]]:text-workspace-chrome"
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
        {#if promotionError}
          <p class="px-2.5 py-2 text-xs text-(--failure)">{promotionError}</p>
        {/if}
        {#each taskSections as section (section.key)}
          <Command.Group heading={section.label}>
            {#each section.tasks as task (task.id)}
              <Command.Item
                value="{task.title} {task.shortId ?? ''} {task.id}"
                onSelect={() => void selectTask(task)}
                disabled={promotingId !== null}
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
                {#if promotingId === task.id}
                  <span class="shrink-0 text-(--solus-text-tertiary)">Importing…</span>
                {/if}
                {#if selectedTask?.id === task.id}
                  <CheckIcon size={12} class="shrink-0 text-(--solus-accent)" />
                {/if}
              </Command.Item>
            {/each}
          </Command.Group>
        {/each}
      </Command.List>
    </Command.Root>
    <MenuFooter hints={[["⏎", "select"]]} summary="{tasks.length} tasks" />
  </Popover.Content>
</Popover.Root>

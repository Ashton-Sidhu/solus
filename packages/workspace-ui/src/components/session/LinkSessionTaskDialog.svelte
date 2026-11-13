<script lang="ts">
  import { useScope } from "../../lib/keybindings/use-keybinding.svelte";
  import { onMount } from "svelte";
  import type { Task } from "@solus/contracts/task-types";
  import { getWorkspaceContext } from "../../contexts";
  import { linkTabToTask } from "../../contexts/workspace/session-task-link";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { toasts } from "../../lib/toasts";
  import * as Command from "../ui/command";
  import * as Popover from "../ui/popover";
  import { MenuSearch } from "../ui/menu";
  import TaskIcon from "../ui/TaskIcon.svelte";
  import { taskPickerSections } from "../tasks/lib/task-picker-sections";
  import { taskRef } from "../tasks/lib/tasks-api";
  import {
    ProviderTaskSearch,
    tasksOnlyFound,
  } from "../../lib/provider-task-search.svelte";

  /**
   * Pick the task a session belongs to. The link is made at once, so the
   * session's pull requests show on the task from then on
   * (docs/plans/session-pull-requests.md).
   */
  interface Props {
    /** Tab whose session is linked. */
    tabId: string;
    onClose: () => void;
    /** The header icon that anchors the picker, when opened from a conversation. */
    anchor?: HTMLElement | null;
  }

  let { tabId, onClose, anchor = null }: Props = $props();

  const session = getWorkspaceContext();
  const tasks = $derived(session.tasksStore.tasks.filter((task) => task.category !== "done"));
  const sections = $derived(taskPickerSections(tasks));
  // The host lists at most a part of a large task source. A query also asks
  // the provider, and the tasks only it found show below the listed ones.
  const providerSearch = new ProviderTaskSearch((text) => session.tasksStore.search(text));
  const foundTasks = $derived(tasksOnlyFound(providerSearch.results, tasks));

  let query = $state("");
  /** The task whose link is in flight. */
  let linkingTaskId = $state<string | null>(null);

  let dialogEl = $state<HTMLDivElement | null>(null);

  onMount(() => {
    void session.tasksStore.ensureLoaded();
    dialogEl?.querySelector<HTMLInputElement>("input")?.focus();
  });

  function close(): void {
    onClose();
    requestInputFocus({ tabId });
  }

  async function pick(task: Task): Promise<void> {
    if (linkingTaskId) return;
    linkingTaskId = task.id;
    try {
      await linkTabToTask(session, tabId, task);
      close();
    } catch (error) {
      toasts.error("Couldn't link the session to the task", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      linkingTaskId = null;
    }
  }

  $effect(() => {
    providerSearch.request(query);
    return () => providerSearch.cancel();
  });

  // A modal: shortcuts behind it stay quiet while it is open.
  useScope("modal-dialog", { exclusive: true, pre: true, active: () => !anchor });
</script>

{#snippet taskList()}
    <div class="px-3.5 pt-3 pb-1">
      <span class="font-medium">Link to task</span>
    </div>
    <Command.Root>
      <MenuSearch bind:value={query} placeholder="Search tasks" />
      <Command.List class="max-h-[18rem] overflow-y-auto p-1.5">
        {#if !providerSearch.searching && foundTasks.length === 0}
          <Command.Empty class="px-2.5 py-3 text-center text-xs text-(--solus-text-tertiary)">
            No tasks match
          </Command.Empty>
        {/if}
        {#each sections as section (section.key)}
          <Command.Group heading={section.label}>
            {#each section.tasks as task (task.id)}
              <Command.Item
                value="{task.title} {task.reference ?? ''} {task.id}"
                onSelect={() => void pick(task)}
                disabled={linkingTaskId !== null}
              >
                <TaskIcon size={13} class="shrink-0 text-(--solus-text-tertiary)" />
                <span class="min-w-0 flex-1 truncate">{task.title}</span>
                <span class="shrink-0 text-(--solus-text-tertiary)">
                  {linkingTaskId === task.id ? "Linking…" : taskRef(task)}
                </span>
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
                onSelect={() => void pick(task)}
                disabled={linkingTaskId !== null}
              >
                <TaskIcon size={13} class="shrink-0 text-(--solus-text-tertiary)" />
                <span class="min-w-0 flex-1 truncate">{task.title}</span>
                <span class="shrink-0 text-(--solus-text-tertiary)">
                  {linkingTaskId === task.id ? "Linking…" : taskRef(task)}
                </span>
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
{/snippet}

{#if anchor}
  <Popover.Root open onOpenChange={(open) => { if (!open) close(); }}>
    <Popover.Content
      data-solus-ui
      bind:ref={dialogEl}
      customAnchor={anchor}
      side="bottom"
      align="end"
      sideOffset={8}
      collisionPadding={8}
      aria-label="Link session to task"
      onEscapeKeydown={(event) => event.stopPropagation()}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        requestInputFocus({ tabId });
      }}
      class="menu-surface z-[10008] w-[min(20rem,calc(100vw-1rem))] gap-0 rounded-2xl bg-(--solus-menu-bg) p-0 text-workspace-chrome shadow-[shadow:var(--solus-menu-shadow)] ring-0"
    >
      {@render taskList()}
    </Popover.Content>
  </Popover.Root>
{:else}
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  data-solus-ui
  class="pointer-events-auto fixed inset-0 z-[10008] flex items-start justify-center modal-backdrop pt-[18vh]"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) close();
  }}
  onkeydown={(e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  }}
>
  <div
    bind:this={dialogEl}
    class="menu-surface flex w-[min(24rem,calc(100vw-2rem))] flex-col rounded-2xl bg-(--solus-menu-bg) text-workspace-chrome shadow-[shadow:var(--solus-menu-shadow)]"
    role="dialog"
    aria-label="Link session to task"
    aria-modal="true"
  >
    {@render taskList()}
  </div>
</div>

{/if}

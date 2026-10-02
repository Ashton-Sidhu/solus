<script lang="ts">
  import { onMount } from "svelte";
  import type { Task } from "@solus/contracts/task-types";
  import { getWorkspaceContext } from "../../contexts";
  import { linkTabToTask } from "../../contexts/workspace/session-task-link";
  import { environmentProjectKey } from "../../contexts/git/session-environment.store.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { toasts } from "../../lib/toasts";
  import * as Command from "../ui/command";
  import * as Popover from "../ui/popover";
  import { MenuSearch } from "../ui/menu";
  import TaskIcon from "../ui/TaskIcon.svelte";
  import { taskPickerSections } from "../tasks/lib/task-picker-sections";

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
  const sess = $derived(session.sessionFor(tabId));
  const projectKey = $derived(
    sess
      ? environmentProjectKey(
          session.environment.environmentFor(sess.run),
          sess.run.projectGroupPath,
        )
      : "~",
  );
  const tasks = $derived(
    session.tasksStore
      .tasksForCheckout(sess?.run.taskServerId ?? session.serverIdFor(tabId), projectKey)
      .filter((task) => task.status !== "done" && task.status !== "dropped"),
  );
  const sections = $derived(taskPickerSections(tasks));

  let query = $state("");
  /** The task whose link is in flight. A provider ticket is imported first. */
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
</script>

{#snippet taskList()}
    <div class="px-3.5 pt-3 pb-1">
      <span class="font-medium">Link to task</span>
    </div>
    <Command.Root>
      <MenuSearch bind:value={query} placeholder="Search tasks" />
      <Command.List class="max-h-[18rem] overflow-y-auto p-1.5">
        <Command.Empty class="px-2.5 py-3 text-center text-xs text-(--solus-text-tertiary)">
          No tasks match
        </Command.Empty>
        {#each sections as section (section.key)}
          <Command.Group heading={section.label}>
            {#each section.tasks as task (task.id)}
              <Command.Item
                value="{task.title} {task.shortId ?? ''} {task.id}"
                onSelect={() => void pick(task)}
                disabled={linkingTaskId !== null}
              >
                <TaskIcon size={13} class="shrink-0 text-(--solus-text-tertiary)" />
                <span class="min-w-0 flex-1 truncate">{task.title}</span>
                {#if linkingTaskId === task.id}
                  <span class="shrink-0 text-(--solus-text-tertiary)">Linking…</span>
                {/if}
              </Command.Item>
            {/each}
          </Command.Group>
        {/each}
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
  class="pointer-events-auto fixed inset-0 z-[10008] flex items-start justify-center bg-transparent pt-[18vh]"
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

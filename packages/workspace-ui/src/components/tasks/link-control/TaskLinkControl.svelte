<script lang="ts">
  import { Check as CheckIcon, Link as LinkIcon, ChevronDown as CaretDownIcon } from "@lucide/svelte";
  import { mergeProps } from "bits-ui";
  import type { TaskLinkTarget } from "@solus/contracts/task-types";
  import { getWorkspaceContext } from "../../../contexts";
  import { requestInputFocus } from "../../../lib/inputFocus";
  import { toasts } from "../../../lib/toasts";
  import * as Command from "../../ui/command";
  import { MenuFooter, MenuSearch } from "../../ui/menu";
  import * as Popover from "../../ui/popover";
  import {
    linkVerb,
    linkedTaskRef,
    taskLinkControlState,
    taskLinkPickerRows,
  } from "./lib/task-link-control";

  /**
   * The Link control a conversation card carries in its rail: which task this
   * document, plan, automation, or artifact belongs to, one click to file it
   * under the conversation's own task, and the way back out.
   *
   * The edges come from the tasks store (`linkedTasksByTarget`), never from
   * the host directly, so every card showing the same target agrees and a
   * host broadcast refreshes them all at once.
   */
  interface Props {
    target: TaskLinkTarget;
    /** The link-time snapshot title the host stores beside the edge. */
    title: string;
    url?: string | null;
    /** Where the conversation lives — the host that owns its tasks. */
    serverId?: string;
    /** The conversation's project, which scopes the picker's live tasks. */
    projectKey?: string | null;
    /** The task the conversation itself belongs to: the one-click target. */
    conversationTaskId?: string | null;
  }

  let { target, title, url, serverId, projectKey, conversationTaskId }: Props = $props();

  const session = getWorkspaceContext();
  const store = session.tasksStore;

  const linked = $derived(store.linkedTasksFor(target));
  const currentTask = $derived(conversationTaskId ? store.peek(conversationTaskId) : null);
  const controlState = $derived(
    taskLinkControlState(
      linked,
      currentTask
        ? { taskId: currentTask.id, title: currentTask.title, status: currentTask.status, shortId: currentTask.shortId }
        : null,
    ),
  );

  // Ask once per target; the store answers every later read.
  $effect(() => {
    const key = `${target.kind}:${target.targetScope}:${target.targetKey}`;
    void key;
    void store.ensureLinkedTasks([target], serverId);
  });

  let open = $state(false);
  let query = $state("");
  /** The row whose link/unlink is in flight; only that row shows progress. */
  let busyTaskId = $state<string | null>(null);
  let triggerEl = $state<HTMLButtonElement | null>(null);

  const candidates = $derived(
    (projectKey ? store.tasksForProject(projectKey) : store.tasks)
      .filter((task) => task.kind === "task" && task.status !== "done" && task.status !== "dropped")
      .map((task) => ({ taskId: task.id, title: task.title, status: task.status, shortId: task.shortId })),
  );
  const rows = $derived(taskLinkPickerRows(candidates, linked ?? [], conversationTaskId ?? null));

  function openMenu(next: boolean) {
    open = next;
    if (next) {
      query = "";
      void store.ensureLoaded();
    }
  }

  async function toggle(taskId: string, isLinked: boolean) {
    if (busyTaskId) return;
    busyTaskId = taskId;
    const task = store.get(taskId);
    // Publish the intended state before the host round trip. The task method
    // confirms the same edge afterwards; a failed write restores this snapshot.
    if (isLinked) store.noteUnlinked(target, taskId);
    else store.noteLinked(target, task);
    try {
      if (isLinked) await task.unlink(target.kind, target.targetKey, target.targetScope);
      else await task.link({ kind: target.kind, targetScope: target.targetScope, targetKey: target.targetKey, title, url });
    } catch (error) {
      if (isLinked) store.noteLinked(target, task);
      else store.noteUnlinked(target, taskId);
      toasts.error(isLinked ? "Couldn't unlink from the task" : "Couldn't link to the task", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      busyTaskId = null;
    }
  }

  function linkToCurrent() {
    if (controlState.kind !== "none" || !controlState.currentTask) return;
    void toggle(controlState.currentTask.taskId, false);
    requestInputFocus();
  }

  function unlinkOnly() {
    if (controlState.kind !== "one") return;
    void toggle(controlState.task.taskId, true);
    requestInputFocus();
  }

  function openTask(taskId: string) {
    session.goToTask(taskId, "click");
  }

  function stopTriggerClick(event: MouseEvent) {
    event.stopPropagation();
  }

  function handleCloseAutoFocus(event: Event) {
    event.preventDefault();
    requestInputFocus();
  }
</script>

{#if controlState.kind !== "unknown"}
  <span class="flex min-w-0 items-center gap-0.5" data-testid="task-link-control">
    {#if controlState.kind === "one"}
      <button
        type="button"
        class="task-link-control__action flex min-w-0 cursor-pointer items-center gap-1.5 overflow-hidden rounded-md px-2 py-[0.3125rem]"
        title={`Open ${linkedTaskRef(controlState.task)}`}
        onclick={(e) => {
          e.stopPropagation();
          openTask(controlState.kind === "one" ? controlState.task.taskId : "");
        }}
        data-testid="task-link-open"
      >
        <LinkIcon size={11} class="shrink-0 opacity-70" />
        <span class="min-w-0 truncate">{controlState.label}</span>
      </button>
      <button
        type="button"
        class="task-link-control__action shrink-0 cursor-pointer rounded-md px-2 py-[0.3125rem]"
        aria-disabled={busyTaskId !== null}
        aria-busy={busyTaskId !== null}
        onclick={(e) => {
          e.stopPropagation();
          void unlinkOnly();
        }}
        data-testid="task-link-unlink"
      >
        Unlink
      </button>
    {:else if controlState.kind === "none" && controlState.currentTask}
      <button
        type="button"
        class="task-link-control__action flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 py-[0.3125rem]"
        aria-disabled={busyTaskId !== null}
        aria-busy={busyTaskId !== null}
        onclick={(e) => {
          e.stopPropagation();
          void linkToCurrent();
        }}
        data-testid="task-link-current"
      >
        <LinkIcon size={11} class="shrink-0 opacity-70" />
        {linkVerb(controlState)}
      </button>
    {/if}

    <Popover.Root bind:open onOpenChange={openMenu}>
      <Popover.Trigger>
        {#snippet child({ props })}
          {#if controlState.kind === "many"}
            <button
              {...mergeProps(props, { onclick: stopTriggerClick })}
              bind:this={triggerEl}
              type="button"
              class="task-link-control__action flex min-w-0 cursor-pointer items-center gap-1.5 overflow-hidden rounded-md px-2 py-[0.3125rem]"
              data-testid="task-link-manage"
            >
              <LinkIcon size={11} class="shrink-0 opacity-70" />
              <span class="min-w-0 truncate">{controlState.label}</span>
              <span class="shrink-0 opacity-70">· Manage</span>
            </button>
          {:else if controlState.kind === "none" && !controlState.currentTask}
            <button
              {...mergeProps(props, { onclick: stopTriggerClick })}
              bind:this={triggerEl}
              type="button"
              class="task-link-control__action flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 py-[0.3125rem]"
              data-testid="task-link-pick"
            >
              <LinkIcon size={11} class="shrink-0 opacity-70" />
              {linkVerb(controlState)}
            </button>
          {:else}
            <!-- A one-click verb or a single link beside it: the picker is the
                 caret, for another task than the obvious one. -->
            <button
              {...mergeProps(props, { onclick: stopTriggerClick })}
              bind:this={triggerEl}
              type="button"
              class="task-link-control__action flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md"
              title="Choose tasks"
              aria-label="Choose tasks to link"
              data-testid="task-link-more"
            >
              <CaretDownIcon size={11} />
            </button>
          {/if}
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
        class="menu-surface z-[10002] w-[min(20rem,calc(100vw-2rem))] gap-0 rounded-2xl bg-(--solus-menu-bg) p-0 text-workspace-chrome shadow-[shadow:var(--solus-menu-shadow)] ring-0 lg:text-workspace-chrome [&_.menu-row]:text-workspace-chrome [&_[data-slot=command-input]]:text-workspace-chrome"
      >
        <Command.Root>
          <MenuSearch bind:value={query} placeholder="Link to tasks" />
          <Command.List class="max-h-[288px] overflow-y-auto p-1.5">
            <Command.Empty class="px-2.5 py-3 text-center text-xs text-(--solus-text-tertiary)">
              No tasks match
            </Command.Empty>
            {#each rows as row (row.taskId)}
              <Command.Item
                value="{row.title} {row.shortId ?? ''} {row.taskId}"
                onSelect={() => void toggle(row.taskId, row.linked)}
                disabled={busyTaskId !== null}
                data-menu-current={row.linked ? "" : undefined}
                class="menu-item-stagger"
                role="menuitemcheckbox"
                aria-checked={row.linked}
              >
                <span
                  class="flex size-3.5 shrink-0 items-center justify-center rounded-[0.25rem] border {row.linked
 ? 'border-(--solus-accent) bg-(--solus-accent) text-(--solus-text-on-accent)'
 : 'border-(--solus-menu-hairline)'}"
                  aria-hidden="true"
                >
                  {#if row.linked}<CheckIcon size={10} />{/if}
                </span>
                <span class="shrink-0 tabular-nums text-(--solus-text-tertiary)">{linkedTaskRef(row)}</span>
                <span class="min-w-0 flex-1 truncate">{row.title}</span>
                {#if busyTaskId === row.taskId}
                  <span class="shrink-0 text-(--solus-text-tertiary)">Saving…</span>
                {:else if row.current}
                  <span class="shrink-0 text-(--solus-text-tertiary)">This chat</span>
                {/if}
              </Command.Item>
            {/each}
          </Command.List>
        </Command.Root>
        <MenuFooter hints={[["⏎", "toggle"]]} summary="{linked?.length ?? 0} linked" />
      </Popover.Content>
    </Popover.Root>
  </span>
{/if}

<style>
  /* The same ghost verb the card rails use, so the control reads as part of
     the rail rather than a widget dropped into it. */
  .task-link-control__action {
    border: none;
    background: transparent;
    color: var(--muted-foreground);
    font-size: var(--text-xs);
    font-weight: 500;
    transition:
      background var(--duration-quick) var(--ease-premium),
      color var(--duration-quick) var(--ease-premium);
  }

  .task-link-control__action:hover:not(:disabled) {
    background: color-mix(in oklch, var(--foreground) 5%, transparent);
    color: var(--solus-text-primary);
  }

  .task-link-control__action[aria-disabled="true"] {
    cursor: default;
  }

  .task-link-control__action:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border-medium);
    outline-offset: 0.125rem;
  }
</style>

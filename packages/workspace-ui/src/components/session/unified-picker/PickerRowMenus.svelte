<script lang="ts">
  import type { Task } from "@solus/contracts/task-types";
  import type { TaskStatusCategory } from "@solus/contracts/task-sources";
  import type { SessionMeta } from "@solus/contracts/types";
  import { getWorkspaceContext } from "../../../contexts";
  import type { SidebarSessionChild } from "../../../contexts/workspace/session-sidebar.store.svelte";
  import { sessionListStore } from "../../../contexts/workspace/session-list.store.svelte";
  import { toasts } from "../../../lib/toasts";
  import SessionContextMenu from "../SessionContextMenu.svelte";
  import TaskContextMenu from "../TaskContextMenu.svelte";
  import type { PickerRowMenu } from "./lib/picker-row-menu";

  /**
   * The menu of a row's own actions: a task's, or a session's.
   *
   * Every move here is the same one the sidebar's row menu makes, on the same
   * store calls, so a task looks identical whichever surface changed it. The
   * search stays open for status and archive — they are edits to a row you
   * are still choosing between — and the parent closes it for anything that
   * navigates.
   */
  interface Props {
    menu: PickerRowMenu | null;
    sessionsFor: (task: Task) => SidebarSessionChild[];
    /** Where the menus portal, so they paint above the search's scrim. */
    portalTarget: HTMLElement | null;
    onStart: (task: Task) => void;
    onResume: (task: Task) => void;
    onOpenTask: (task: Task) => void;
    onOpenSource: (task: Task) => void;
  }
  let { menu = $bindable(), sessionsFor, portalTarget, onStart, onResume, onOpenTask, onOpenSource }: Props = $props();

  const session = getWorkspaceContext();

  async function moveTask(task: Task, category: TaskStatusCategory): Promise<void> {
    try {
      await session.tasksStore.get(task.id).move({ category });
    } catch (error) {
      toasts.error("Couldn't update status", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Only a draft can be deleted (`Task.canDelete`). */
  function deleteTask(task: Task): void {
    const pending = session.tasksStore.softRemove([task.id]);
    if (!pending.length) return;
    toasts.undo("Task deleted", () => session.tasksStore.restorePending(pending), {
      onDismiss: () =>
        session.tasksStore.commitPending(pending).catch((error) =>
          toasts.error("Couldn't delete task", {
            description: error instanceof Error ? error.message : String(error),
          })),
    });
  }

  /** Archive a conversation the hosts listed, or return it to the list
   *  (docs/plans/session-archive.md). Its row keeps its place, with its mark. */
  function archiveActions(conversation: SessionMeta | null) {
    const serverId = conversation?.serverId;
    if (!conversation || !serverId) return {};
    const setArchived = (isArchived: boolean) => {
      void sessionListStore.setArchived({ serverId, sessionId: conversation.sessionId, organizationId: conversation.organizationId, publication: conversation.publication }, isArchived)
        .then(() => { conversation.archived = isArchived || undefined; })
        .catch((error) => toasts.error(isArchived ? "Couldn't archive it" : "Couldn't return it to the list", {
          description: error instanceof Error ? error.message : String(error),
        }));
    };
    return conversation.archived
      ? { onUnarchive: () => setArchived(false) }
      : { onArchive: () => setArchived(true) };
  }
</script>

{#if menu?.kind === "task"}
  {@const menuTask = menu.task}
  {@const hasSessions = sessionsFor(menuTask).length > 0}
  <TaskContextMenu
    x={menu.x}
    y={menu.y}
    task={menuTask}
    hasLinkedSession={hasSessions}
    isRunning={false}
    onStart={() => onStart(menuTask)}
    onResume={hasSessions ? () => onResume(menuTask) : undefined}
    onOpenTask={() => onOpenTask(menuTask)}
    onOpenSource={menuTask.url ? () => onOpenSource(menuTask) : undefined}
    onSetStatus={(category) => void moveTask(menuTask, category)}
    onDelete={session.tasksStore.get(menuTask.id).canDelete ? () => deleteTask(menuTask) : undefined}
    {portalTarget}
    onClose={() => (menu = null)}
  />
{:else if menu?.kind === "session"}
  {@const menuSession = menu.session}
  <SessionContextMenu
    x={menu.x}
    y={menu.y}
    tabId={menuSession.tabId ?? null}
    sessionId={menuSession.sessionId ?? null}
    serverId={menuSession.serverId ?? null}
    showSplit
    rowActions={{
      onStop: menuSession.attention === "running" && menuSession.tabId
        ? () => session.controls.interruptTabSession(menuSession.tabId!)
        : undefined,
      ...archiveActions(menu.conversation),
    }}
    {portalTarget}
    onClose={() => (menu = null)}
  />
{/if}

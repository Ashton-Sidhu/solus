<script lang="ts">
  import type { Issue } from "@solus/contracts/task-types";
  import type { IssueStatusCategory } from "@solus/contracts/task-sources";
  import type { SessionMeta } from "@solus/contracts/types";
  import { getSessionSidebarStore, getWorkspaceContext } from "../../../contexts";
  import type { SidebarSessionChild } from "../../../contexts/workspace/session-sidebar.store.svelte";
  import { setListedSessionArchived } from "../lib/session-actions";
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
    sessionsFor: (task: Issue) => SidebarSessionChild[];
    /** Where the menus portal, so they paint above the search's scrim. */
    portalTarget: HTMLElement | null;
    onStart: (task: Issue) => void;
    onResume: (task: Issue) => void;
    onOpenTask: (task: Issue) => void;
    onOpenSource: (task: Issue) => void;
  }
  let { menu = $bindable(), sessionsFor, portalTarget, onStart, onResume, onOpenTask, onOpenSource }: Props = $props();

  const session = getWorkspaceContext();
  const sidebarStore = getSessionSidebarStore();

  async function moveTask(task: Issue, category: IssueStatusCategory): Promise<void> {
    try {
      await session.issuesStore.get(task.id).move({ category });
    } catch (error) {
      toasts.error("Couldn't update status", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Only a draft can be deleted (`Task.canDelete`). */
  function deleteTask(task: Issue): void {
    const pending = session.issuesStore.softRemove([task.id]);
    if (!pending.length) return;
    toasts.undo("Issue deleted", () => session.issuesStore.restorePending(pending), {
      onDismiss: () =>
        session.issuesStore.commitPending(pending).catch((error) =>
          toasts.error("Couldn't delete issue", {
            description: error instanceof Error ? error.message : String(error),
          })),
    });
  }

  /** Archive a conversation the hosts listed, or return it to the list
   *  (docs/plans/session-archive.md). Its row keeps its place, with its mark. */
  function archiveActions(conversation: SessionMeta | null) {
    const serverId = conversation?.serverId;
    if (!conversation || !serverId) return {};
    const target = { serverId, sessionId: conversation.sessionId, organizationId: conversation.organizationId, publication: conversation.publication };
    const setArchived = (isArchived: boolean) => {
      void setListedSessionArchived(sidebarStore, target, isArchived).then((changed) => {
        if (changed) conversation.archived = isArchived || undefined;
      });
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
    onDelete={session.issuesStore.get(menuTask.id).canDelete ? () => deleteTask(menuTask) : undefined}
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
      onStop: (menuSession.attention === "running" || menuSession.attention === "starting") && menuSession.tabId
        ? () => session.controls.interruptTabSession(menuSession.tabId!)
        : undefined,
      ...archiveActions(menu.conversation),
    }}
    {portalTarget}
    onClose={() => (menu = null)}
  />
{/if}

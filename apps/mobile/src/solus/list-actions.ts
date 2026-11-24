import { Alert } from "react-native";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import * as ThreadUndo from "@t3tools/client-runtime/state/thread-undo";
import { showThreadUndoNotice } from "../features/home/thread-undo-notice";
import { scopedThreadKey } from "../lib/scopedEntities";
import * as Dialog from "../components/ui/Dialog";
import { hostQueryScope } from "../state/host-query-scope";
import {
  createThreadMovePlanner,
  threadDropLifecycle,
  type ThreadMoveDestination,
} from "../features/threads/threadOrder";
import { getThreadListV2OrderedSection } from "../features/threads/threadListV2";
import { queuedEditDraftKey } from "../state/queued-edit-draft-key";
import { abortComposerDraftOperationsWhere } from "../state/composerDraftOperations";
import { appAtomRegistry } from "../state/atom-registry";
import { threadDropBusyAtom } from "../state/thread-order";
import { queuedThreadKeysAtom } from "../state/use-thread-outbox";
import {
  navigationThreadsAtom,
  getSolusDirectory,
  noteSessionListAction,
  refreshSessionRow,
  solus,
} from "./runtime";

/** A pin changes the pins a whole read lists; every other action changes only session records. */
async function change(
  thread: EnvironmentThreadShell,
  operation: () => Promise<void>,
  scope: "all" | "sessions" = "sessions",
) {
  try {
    noteSessionListAction(thread.environmentId);
    await operation();
    if (scope === "all") await solus.threads.load(thread.environmentId, 0, scope);
    else refreshSessionRow(thread.environmentId, thread.id);
    return true;
  } catch (error) {
    Alert.alert(
      "Could not update the session",
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

async function pin(thread: EnvironmentThreadShell, wanted: boolean) {
  const session = solus.threads.thread(thread.environmentId, thread.id);
  if (!session) return false;
  if (!!solus.threadList.facts().pins?.has(session.key) === wanted) return true;
  return change(thread, () => solus.threadList.togglePin(session), "all");
}

async function updateList(
  thread: EnvironmentThreadShell,
  run: () => Promise<boolean>,
  action?: "settle" | "snooze" | "unpin",
) {
  const key = scopedThreadKey(thread.environmentId, thread.id);
  const claim = ThreadUndo.begin("solus-list", key);
  const succeeded = await run();
  if (!action || !succeeded || !claim.isCurrent()) {
    claim.finish();
    return succeeded;
  }
  const plan = ThreadUndo.planThreadUndo(action, thread);
  showThreadUndoNotice({
    action: action === "settle" ? "Settled" : action === "snooze" ? "Snoozed" : "Unpinned",
    claim,
    undo: async () => {
      await ThreadUndo.executeThreadUndo(
        plan,
        async (step) => {
          switch (step.action) {
            case "unsettle":
              return change(thread, () =>
                solus.threadList.setSettled(thread.environmentId, thread.id, false),
              );
            case "pin":
              return pin(thread, true);
            case "snooze":
            case "unsnooze":
              return change(thread, () =>
                solus.threadList.snooze(
                  thread.environmentId,
                  thread.id,
                  step.action === "snooze" ? Date.parse(step.snoozedUntil) : null,
                ),
              );
            case "reorderActive":
              return change(thread, () =>
                solus.threadList.setListControls(thread.environmentId, thread.id, {
                  activeOrderKey: step.orderKey,
                }),
              );
          }
        },
        (ok) => ok,
      );
    },
  });
  return true;
}

function hostFor(t: EnvironmentThreadShell) {
  const host = solus.connections.connection(t.environmentId);
  if (host?.state.readiness !== "ready") throw new Error("Reconnect to this environment.");
  return host.api;
}

const generatingTitles = new Set<string>();

async function moveThread(t: EnvironmentThreadShell, destination: ThreadMoveDestination) {
  const navigation = appAtomRegistry.get(navigationThreadsAtom);
  if (navigation.holding || appAtomRegistry.get(threadDropBusyAtom)) return false;
  const { threads, listHosts } = getSolusDirectory();
  const keyOf = (row: EnvironmentThreadShell) => scopedThreadKey(row.environmentId, row.id);
  const rows = new Map(threads.map((row) => [keyOf(row), row]));
  const current = rows.get(keyOf(t));
  if (!current || current.archivedAt || !listHosts.listControlEnvironmentIds.has(t.environmentId))
    return false;
  const section =
    (typeof destination === "object" && destination.section) ||
    (current.pinnedAt ? "pinned" : "active");
  if (section === "settled") {
    if (current.pinnedAt == null) return listActions.settleThread(current);
    if (current.settledOverride === "settled") return listActions.unpinThread(current);
    if (!(await listActions.settleThread(current))) return false;
    return pin(current, false);
  }
  const now = new Date().toISOString();
  const ordered = getThreadListV2OrderedSection({
    threads,
    section,
    now,
    queuedThreadKeys: appAtomRegistry.get(queuedThreadKeysAtom),
  });
  const assignments = createThreadMovePlanner({
    ordered,
    allThreads: threads,
    section,
    reorderableEnvironmentIds: listHosts.listControlEnvironmentIds,
  })(keyOf(t), destination);
  if (!assignments) return false;
  const scopes = new Map(
    [...listHosts.listControlEnvironmentIds].map((id) => [id, hostQueryScope(id)]),
  );
  const check = (row: EnvironmentThreadShell) => {
    if (hostQueryScope(row.environmentId) !== scopes.get(row.environmentId))
      throw new Error("The connection changed.");
  };
  appAtomRegistry.set(threadDropBusyAtom, true);
  try {
    return await change(current, async () => {
      if (!ordered.includes(current)) {
        const lifecycle = threadDropLifecycle(current, section, now);
        if (lifecycle.unsnooze || (section === "pinned" && current.snoozedUntil))
          await solus.threadList.snooze(t.environmentId, t.id, null);
        check(current);
        if (lifecycle.unsettle)
          await solus.threadList.setSettled(t.environmentId, t.id, false);
        check(current);
        if (lifecycle.pin || lifecycle.unpin) {
          if (!(await pin(current, lifecycle.pin))) throw new Error("Could not move the session.");
        }
      }
      for (const assignment of assignments) {
        const row = rows.get(assignment.id)!;
        check(row);
        await solus.threadList.setListControls(
          row.environmentId,
          row.id,
          section === "active"
            ? { activeOrderKey: assignment.orderKey }
            : { pinOrderKey: assignment.orderKey },
        );
        refreshSessionRow(row.environmentId, row.id);
      }
    });
  } finally {
    appAtomRegistry.set(threadDropBusyAtom, false);
  }
}

export const listActions = {
  async setRead(thread: EnvironmentThreadShell, read: boolean) {
    try {
      await solus.threadList.markRead(thread.environmentId, thread.id, read);
    } catch (error) {
      Alert.alert(
        "Could not update read status",
        error instanceof Error ? error.message : String(error),
      );
    }
  },
  archiveThread: (t: EnvironmentThreadShell) =>
    updateList(t, () => change(t, async () => {
      await solus.threadList.setArchived(t.environmentId, t.id, true);
      const key = scopedThreadKey(t.environmentId, t.id);
      abortComposerDraftOperationsWhere((draftKey) => draftKey === key || draftKey.startsWith(queuedEditDraftKey(key, "")));
    })),
  unarchiveThread: (t: EnvironmentThreadShell) =>
    change(t, () => solus.threadList.setArchived(t.environmentId, t.id, false)),
  settleThread: (t: EnvironmentThreadShell) =>
    updateList(
      t,
      () => change(t, () => solus.threadList.setSettled(t.environmentId, t.id, true)),
      "settle",
    ),
  unsettleThread: (t: EnvironmentThreadShell) =>
    updateList(t, () => change(t, () => solus.threadList.setSettled(t.environmentId, t.id, false))),
  snoozeThread: (t: EnvironmentThreadShell, date: string) =>
    updateList(
      t,
      () => change(t, () => solus.threadList.snooze(t.environmentId, t.id, Date.parse(date))),
      "snooze",
    ),
  unsnoozeThread: (t: EnvironmentThreadShell) =>
    updateList(t, () => change(t, () => solus.threadList.snooze(t.environmentId, t.id, null))),
  pinThread: (t: EnvironmentThreadShell) => updateList(t, () => pin(t, true)),
  unpinThread: (t: EnvironmentThreadShell) => updateList(t, () => pin(t, false), "unpin"),
  setThreadAutoSettle: (t: EnvironmentThreadShell, enabled: boolean) =>
    change(t, () =>
      solus.threadList.setListControls(t.environmentId, t.id, { autoSettle: enabled }),
    ),
  moveThread,
  async regenerateThreadTitle(t: EnvironmentThreadShell) {
    const scope = hostQueryScope(t.environmentId);
    const key = JSON.stringify([scope, t.environmentId, t.id]);
    if (generatingTitles.has(key)) return false;
    generatingTitles.add(key);
    try {
      return await change(t, async () => {
        const api = hostFor(t);
        const info = await api.getSessionInfo(t.id);
        const prompt = info?.firstMessage?.trim();
        if (!prompt) throw new Error("Could not find the opening prompt.");
        if (hostQueryScope(t.environmentId) !== scope) throw new Error("The connection changed.");
        const result = await api.generateSessionMetadata(prompt, info?.cwd || t.projectId, {
          sessionId: t.id,
          executionPreferences: solus.personal.executionPreferences(),
        });
        if (!result?.title) throw new Error("Could not generate a session title.");
        if (hostQueryScope(t.environmentId) !== scope) throw new Error("The connection changed.");
        await api.setSessionTitle(t.id, result.title, "generated", result.description);
        if (t.pinnedAt) await solus.threadList.loadPins(t.environmentId);
      });
    } finally {
      generatingTitles.delete(key);
    }
  },
  renameThread: (t: EnvironmentThreadShell) =>
    Dialog.prompt({
      title: "Rename session",
      initialValue: t.title,
      confirmText: "Save",
      onConfirm: (title) =>
        void change(t, () => solus.threadList.rename(t.environmentId, t.id, title.trim() || null)),
    }),
};

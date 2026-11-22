import { Alert } from "react-native";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import * as ThreadUndo from "@t3tools/client-runtime/state/thread-undo";
import { showThreadUndoNotice } from "../features/home/thread-undo-notice";
import { scopedThreadKey } from "../lib/scopedEntities";
import * as Dialog from "../components/ui/Dialog";
import { solus } from "./runtime";

async function change(thread: EnvironmentThreadShell, operation: () => Promise<void>) {
  try {
    await operation();
    await solus.threads.load(thread.environmentId);
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
  return change(thread, () => solus.threadList.togglePin(session));
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
              return false;
          }
        },
        (ok) => ok,
      );
    },
  });
  return true;
}

const wip = async () => {
  Alert.alert("WIP");
  return false;
};
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
    updateList(t, () => change(t, () => solus.threadList.setArchived(t.environmentId, t.id, true))),
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
  confirmDeleteThread: wip,
  setThreadAutoSettle: wip,
  moveThread: wip,
  regenerateThreadTitle: wip,
  renameThread: (t: EnvironmentThreadShell) =>
    Dialog.prompt({
      title: "Rename session",
      initialValue: t.title,
      confirmText: "Save",
      onConfirm: (title) =>
        void change(t, () => solus.threadList.rename(t.environmentId, t.id, title.trim() || null)),
    }),
};

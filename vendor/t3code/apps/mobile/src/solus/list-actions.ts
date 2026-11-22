import { Alert } from "react-native";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
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

const wip = async () => {
  Alert.alert("WIP");
  return false;
};
export const listActions = {
  archiveThread: (t: EnvironmentThreadShell) =>
    change(t, () => solus.threadList.setArchived(t.environmentId, t.id, true)),
  settleThread: (t: EnvironmentThreadShell) =>
    change(t, () => solus.threadList.setSettled(t.environmentId, t.id, true)),
  unsettleThread: (t: EnvironmentThreadShell) =>
    change(t, () => solus.threadList.setSettled(t.environmentId, t.id, false)),
  snoozeThread: (t: EnvironmentThreadShell, date: string) =>
    change(t, () => solus.threadList.snooze(t.environmentId, t.id, Date.parse(date))),
  unsnoozeThread: (t: EnvironmentThreadShell) =>
    change(t, () => solus.threadList.snooze(t.environmentId, t.id, null)),
  pinThread: (t: EnvironmentThreadShell) => pin(t, true),
  unpinThread: (t: EnvironmentThreadShell) => pin(t, false),
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

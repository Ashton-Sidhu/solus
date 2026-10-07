// Adapted from T3 Code apps/mobile/src/features/home/useThreadListActions.ts (MIT, see UPSTREAM.md).
import * as Haptics from "expo-haptics";
import { useCallback, useRef } from "react";
import { Alert, Platform } from "react-native";

import { useApp } from "../../app/app-context";
import { showTextInputDialog } from "../../components/ConfirmDialogHost";
import type { SolusThreadShell } from "../threads/thread-directory";
import { threadTitle, watchRefusalMessage, type ThreadPrWatchTarget } from "../threads/threadListV2";
import { useThreadListState } from "../threads/use-thread-list";
import { withThreadDismissal } from "./thread-dismissal";

/**
 * The thread list's actions on Solus sessions: settle and un-settle, snooze
 * and wake (the host's session state), and rename. T3's archive, delete, pin,
 * reorder, auto-settle, and title regeneration have no Solus session
 * counterpart and are not offered.
 */

function selectionHaptic() {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
}

function failureMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

export function useThreadListActions(): {
  readonly settleThread: (thread: SolusThreadShell) => Promise<boolean>;
  readonly unsettleThread: (thread: SolusThreadShell) => Promise<boolean>;
  readonly snoozeThread: (thread: SolusThreadShell, snoozedUntil: number) => Promise<boolean>;
  readonly unsnoozeThread: (thread: SolusThreadShell) => Promise<boolean>;
  readonly renameThread: (thread: SolusThreadShell) => void;
  readonly setPullRequestWatch: (thread: SolusThreadShell, target: ThreadPrWatchTarget, watching: boolean) => void;
} {
  const app = useApp();
  const list = useThreadListState();
  const inFlightThreadKeys = useRef(new Set<string>());

  /** Resolves true iff the command reached the host and succeeded. The row
      animates out first; a failure puts it back. */
  const run = useCallback(
    async (
      thread: SolusThreadShell,
      failureTitle: string,
      fallback: string,
      command: () => Promise<void>,
    ): Promise<boolean> => {
      if (inFlightThreadKeys.current.has(thread.key)) return false;
      inFlightThreadKeys.current.add(thread.key);
      selectionHaptic();
      try {
        const error = await withThreadDismissal(
          thread.key,
          () => command().then(() => null, (cause: unknown) => cause ?? new Error(fallback)),
          (result) => result === null,
        );
        if (error !== null) {
          Alert.alert(failureTitle, failureMessage(error, fallback));
          return false;
        }
        return true;
      } finally {
        inFlightThreadKeys.current.delete(thread.key);
      }
    },
    [],
  );

  const settleThread = useCallback(
    (thread: SolusThreadShell) =>
      run(thread, "Could not settle thread", "The thread could not be settled.", () =>
        list.setSettled(thread.hostId, thread.record.sessionId, true),
      ),
    [list, run],
  );
  const unsettleThread = useCallback(
    (thread: SolusThreadShell) =>
      run(thread, "Could not un-settle thread", "The thread could not be un-settled.", () =>
        list.setSettled(thread.hostId, thread.record.sessionId, false),
      ),
    [list, run],
  );
  const snoozeThread = useCallback(
    (thread: SolusThreadShell, snoozedUntil: number) =>
      run(thread, "Could not snooze thread", "The thread could not be snoozed.", () =>
        list.snooze(thread.hostId, thread.record.sessionId, snoozedUntil),
      ),
    [list, run],
  );
  const unsnoozeThread = useCallback(
    (thread: SolusThreadShell) =>
      run(thread, "Could not wake thread", "The thread could not be woken.", () =>
        list.snooze(thread.hostId, thread.record.sessionId, null),
      ),
    [list, run],
  );
  const renameThread = useCallback(
    (thread: SolusThreadShell) => {
      const originalTitle = threadTitle(thread.record);
      const commit = (value: string) => {
        const title = value.trim();
        if (title.length === 0) {
          Alert.alert("Could not rename thread", "Thread title cannot be empty.");
          return;
        }
        if (title === originalTitle) return;
        selectionHaptic();
        list
          .rename(thread.hostId, thread.record.sessionId, title)
          .then(() => app.threads.load(thread.hostId))
          .catch((error: unknown) => {
            Alert.alert(
              "Could not rename thread",
              failureMessage(error, "The thread could not be renamed."),
            );
          });
      };

      if (Platform.OS === "ios") {
        Alert.prompt(
          "Rename thread",
          undefined,
          (title) => commit(title ?? ""),
          "plain-text",
          originalTitle,
        );
        return;
      }
      showTextInputDialog({
        title: "Rename thread",
        initialValue: originalTitle,
        confirmText: "Rename",
        onConfirm: commit,
      });
    },
    [app, list],
  );

  // The row stays where it is: watching changes what wakes the agent, not
  // where the thread sits in the list.
  const setPullRequestWatch = useCallback(
    (thread: SolusThreadShell, target: ThreadPrWatchTarget, watching: boolean) => {
      selectionHaptic();
      void list.setWatching(thread.hostId, thread.record.sessionId, target, watching).then(
        (outcome) => {
          const refusal = watchRefusalMessage(outcome);
          if (refusal) Alert.alert("Could not watch pull request", refusal);
        },
        (error: Error) => {
          Alert.alert(
            watching ? "Could not watch pull request" : "Could not stop watching",
            failureMessage(error, "The host did not answer."),
          );
        },
      );
    },
    [list],
  );

  return { settleThread, unsettleThread, snoozeThread, unsnoozeThread, renameThread, setPullRequestWatch };
}

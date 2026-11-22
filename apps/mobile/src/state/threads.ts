import { createChildThreadApprovalsAtom } from "@t3tools/client-runtime/state/thread-requests";
import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentThreadDetailAtoms,
  createEnvironmentThreadShellAtoms,
  createEnvironmentThreadStateAtoms,
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
  createOlderSettledThreadAtoms,
  createThreadEnvironmentAtoms,
  createThreadFamilyAtoms,
} from "@t3tools/client-runtime/state/threads";
import { createSteadyShellAtoms } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { INITIAL_HISTORY_TURNS, prefetchSessionHistoryPage } from "@solus/client-core/session-history-page";
import { solus } from "../solus/runtime";
import { serverEnvironment } from "./server";
import { environmentShell } from "./shell";

export const threadFamilies = createThreadFamilyAtoms(
  connectionAtomRuntime,
  environmentShell.stateAtom,
);
export const olderSettledThreads = createOlderSettledThreadAtoms(
  connectionAtomRuntime,
  environmentShell.stateAtom,
);
export const threadEnvironment = createThreadEnvironmentAtoms(
  connectionAtomRuntime,
  threadFamilies.snapshotAtom,
);
export const environmentThreads = createEnvironmentThreadStateAtoms(connectionAtomRuntime);
export const environmentThreadDetails = createEnvironmentThreadDetailAtoms(
  environmentThreads.stateAtom,
);
export const environmentThreadShells = createEnvironmentThreadShellAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: threadEnvironment.snapshotAtom,
  hiddenThreadTagsAtom: serverEnvironment.hiddenThreadTagsAtom,
});
const steadyShells = createSteadyShellAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: threadEnvironment.snapshotAtom,
  shellStateAtom: environmentShell.stateValueAtom,
  rowActionsAtom: threadEnvironment.rowActionsAtom,
  connectionStateAtom: environmentCatalog.stateAtom,
});
/**
 * The threads that lists arrange. Rows wait while their environment synchronizes, so a list
 * changes once when environments connect, not once per environment.
 */
export const steadyShellsHoldingAtom = steadyShells.holdingAtom;
export const steadyNavigationThreadShellsAtom = createEnvironmentThreadShellAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: steadyShells.snapshotAtom,
  hiddenThreadTagsAtom: serverEnvironment.hiddenThreadTagsAtom,
}).navigationThreadShellsAtom;
export const childThreadApprovalsAtom = createChildThreadApprovalsAtom({
  childThreadInputsAtom: environmentThreadShells.childThreadInputsAtom,
  pendingRequestsAtom: environmentThreadDetails.pendingRequestsAtom,
});

/** Start the same first page that the conversation will consume after navigation. */
export function startOpeningEnvironmentThread(environmentId: EnvironmentId, threadId: ThreadId) {
  const thread = solus.threads.thread(environmentId, threadId);
  const connection = solus.connections.connection(environmentId);
  if (!thread || thread.cloudOnly || connection?.state.readiness !== "ready" ||
      solus.openConversation(environmentId, threadId)) return;
  const { record } = thread;
  const cache = solus.sessionCache.forHost(environmentId);
  void prefetchSessionHistoryPage(connection.api, {
    sessionId: threadId,
    provider: record.provider,
    projectPath: record.projectPath || record.cwd || undefined,
    turnLimit: INITIAL_HISTORY_TURNS,
  }, 3_000, cache.historyScope(connection.state.sessionGeneration), () => cache.history(threadId)).catch(() => {});
}

const EMPTY_THREAD_STATE_ATOM = Atom.make(AsyncResult.success(EMPTY_ENVIRONMENT_THREAD_STATE)).pipe(
  Atom.withLabel("mobile-environment-thread:empty"),
);

export function useEnvironmentThread(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): EnvironmentThreadState {
  const result = useAtomValue(
    environmentId !== null && threadId !== null
      ? environmentThreads.stateAtom(environmentId, threadId)
      : EMPTY_THREAD_STATE_ATOM,
  );
  const state = AsyncResult.getOrElse(
    result,
    () => EMPTY_ENVIRONMENT_THREAD_STATE,
  ) as EnvironmentThreadState;
  return state;
}

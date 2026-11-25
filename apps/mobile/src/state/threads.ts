import { createChildThreadApprovalsAtom, type PendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import { useAtomValue } from "@effect/atom-react";
import type { UnsettleThreadInput } from "@t3tools/client-runtime/operations";
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
import { RuntimeRequestId, type ScopedThreadRef, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { hostShellSnapshot, shellCatalog } from "../solus/shell-snapshot";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "./atom-registry";
import { scopedThreadKey } from "../lib/scopedEntities";
import { pendingThreadCreationOutcomesAtom, selectThreadCreationDetail } from "./pending-thread-creation";
import { threadOutboxManager } from "./thread-outbox";
import { sessionThreadState } from "../solus/session-thread-state";
import { hostApprovalCard } from "../solus/approval-requests";
import { pendingInputQuestions } from "../solus/pending-question";
import { hasOwnCard } from "@solus-mobile/features/conversation/lib/pending-requests";
import { atomFromConversation } from "../solus/session-detail";
import { hostCommand } from "../solus/host-command";
import { navigationThreadsAtom, noteSessionListAction, refreshSessionRow, solus } from "../solus/runtime";
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
export const threadEnvironment = {
  ...createThreadEnvironmentAtoms(connectionAtomRuntime, threadFamilies.snapshotAtom),
  unsettle: hostCommand(
    "Un-settle thread",
    "host.use",
    async (hostId, { threadId }: UnsettleThreadInput, _registry, check) => {
      noteSessionListAction(hostId);
      await solus.threadList.setSettled(hostId, threadId, false);
      check();
      refreshSessionRow(hostId, threadId);
    },
  ),
};
export const environmentThreads = {
  ...createEnvironmentThreadStateAtoms(connectionAtomRuntime),
  stateAtom: sessionThreadState,
};
const hostPendingRequests = atomFromConversation<PendingThreadRequests>(store => () => {
  const { permissions, questions } = store.metaSnapshotOf();
  const createdAt = new Date(solus.threads.thread(store.controller.hostId, store.controller.run.sessionId)?.record.lastActivityAt ?? 0).toISOString();
  return {
    approvals: permissions.flatMap(permission => {
      const card = !permission.expired && hostApprovalCard(permission);
      return card ? [{ ...card.approval, createdAt }] : [];
    }),
    userInputs: questions.filter(question => !question.expired && !hasOwnCard(question)).map(question => ({
      requestId: RuntimeRequestId.make(question.questionId), createdAt,
      responseCapability: "live" as const, dismissible: question.responseMode === "message",
      ...(question.responseMode && { responseMode: question.responseMode }),
      questions: pendingInputQuestions(question),
    })),
  };
});
const queueCount = atomFromConversation(store => () => store.metaSnapshotOf().queue.entries.length);
const hostQueueCount = Atom.family((atom: ReturnType<typeof queueCount>) => atom.pipe(Atom.map(count => count ?? 0)));
export const environmentThreadDetails = {
  ...createEnvironmentThreadDetailAtoms(sessionThreadState),
  pendingRequestsAtom: (ref: ScopedThreadRef) => hostPendingRequests(ref.environmentId, ref.threadId),
  queuedCountAtom: (ref: ScopedThreadRef) => hostQueueCount(queueCount(ref.environmentId, ref.threadId)),
};
export const environmentThreadShells = createEnvironmentThreadShellAtoms({
  catalogValueAtom: shellCatalog,
  snapshotAtom: hostShellSnapshot,
  hiddenThreadTagsAtom: serverEnvironment.hiddenThreadTagsAtom,
});
export const steadyShellsHoldingAtom = navigationThreadsAtom.pipe(Atom.map(state => state.holding));
export const steadyNavigationThreadShellsAtom = navigationThreadsAtom.pipe(Atom.map(state => state.threads));
export const childThreadApprovalsAtom = createChildThreadApprovalsAtom({
  childThreadInputsAtom: environmentThreadShells.childThreadInputsAtom,
  pendingRequestsAtom: environmentThreadDetails.pendingRequestsAtom,
});

// Long enough for the opened screen to subscribe; its subscription keeps the thread after this.
const OPENING_THREAD_HOLD_MS = 3_000;

/**
 * Starts loading a thread being opened before its screen renders and subscribes, which
 * otherwise waits for navigation to commit.
 */
export function startOpeningEnvironmentThread(environmentId: EnvironmentId, threadId: ThreadId) {
  // A thread whose creation is still queued would load as not found and stay deleted;
  // the opened screen loads it once creation is delivered.
  const { detailRef } = selectThreadCreationDetail({
    threadRef: { environmentId, threadId },
    threadKey: scopedThreadKey(environmentId, threadId),
    queuedMessagesByThreadKey: appAtomRegistry.get(
      threadOutboxManager.queuedMessagesByThreadKeyAtom,
    ),
    outcomes: appAtomRegistry.get(pendingThreadCreationOutcomesAtom),
  });
  if (detailRef === null) return;
  const release = appAtomRegistry.mount(sessionThreadState(environmentId, threadId));
  setTimeout(release, OPENING_THREAD_HOLD_MS);
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
      ? sessionThreadState(environmentId, threadId)
      : EMPTY_THREAD_STATE_ATOM,
  );
  const state = AsyncResult.getOrElse(
    result,
    () => EMPTY_ENVIRONMENT_THREAD_STATE,
  ) as EnvironmentThreadState;
  return state;
}

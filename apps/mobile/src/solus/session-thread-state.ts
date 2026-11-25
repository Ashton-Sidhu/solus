import type { ConversationStore } from "@solus-mobile/features/conversation/conversation-store";
import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
} from "@t3tools/client-runtime/state/threads";
import {
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { solus } from "./runtime";
import { sessionShell } from "./session";
import { sessionDetailAtom } from "./session-detail";
import { sessionFeed } from "./session-feed";

const metaAtom = Atom.family((store: ConversationStore) =>
  Atom.make((get) => {
    get.addFinalizer(store.meta.subscribe(() => get.setSelf(store.metaSnapshotOf())));
    return store.metaSnapshotOf();
  }).pipe(Atom.setIdleTTL(0)),
);

const shellAtom = Atom.family((store: ConversationStore) =>
  Atom.make((get) => {
    const meta = get(metaAtom(store));
    const sessionId = store.controller.run.sessionId;
    const record = solus.threads.thread(store.controller.hostId, sessionId)?.record;
    return sessionShell(
      {
        sessionId,
        projectPath: meta.run.workingDirectory,
        title: meta.run.title,
        customTitle: null,
        createdAt: 0,
        lastActivityAt: 0,
        branch: null,
        cwd: null,
        isWorktree: false,
        ...store.controller.target.record,
        ...record,
        status: record?.status ?? "idle",
        provider: meta.run.provider,
        model: meta.run.model,
      },
      meta.run.permissionMode,
      record?.view,
      record?.state,
      undefined,
      { liveStatus: meta.status },
    );
  }).pipe(Atom.setIdleTTL(0)),
);

const hostThreads = Atom.family((hostId: EnvironmentId) =>
  Atom.family((sessionId: ThreadId) =>
    Atom.make((get) => {
      const store = get(sessionDetailAtom(hostId, sessionId));
      if (!store) return AsyncResult.success(EMPTY_ENVIRONMENT_THREAD_STATE);
      const meta = get(metaAtom(store));
      if (meta.phase.kind === "error" && meta.phase.noAccess)
        return AsyncResult.success({
          ...EMPTY_ENVIRONMENT_THREAD_STATE,
          error: Option.some(meta.phase.message),
        });
      const shell = get(shellAtom(store));
      const projection = get(sessionFeed(store)).projection(shell);
      return AsyncResult.success<EnvironmentThreadState>({
        data: meta.phase.kind === "ready" || projection.visibleTurnItems.length > 0
          ? Option.some(projection) : Option.none(),
        status:
          meta.phase.kind === "ready"
            ? "live"
            : projection.visibleTurnItems.length
              ? "cached"
              : "synchronizing",
        error: meta.phase.kind === "error" ? Option.some(meta.phase.message) : Option.none(),
        history: meta.history,
        sequence: 0,
      });
    }).pipe(Atom.setIdleTTL(0)),
  ),
);

export function sessionThreadState(environmentId: EnvironmentId, threadId: ThreadId) {
  return hostThreads(environmentId)(threadId);
}

import { useAtomValue } from "@effect/atom-react";
import { useListened } from "@solus-mobile/app/app-context";
import { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react";
import { threadRouteIsHydrating } from "../features/threads/thread-route-hydration";
import type { NewTaskDraftRouteParams } from "../features/threads/thread-route-state";
import { hostQueryScope, hostQueryScopeAtom } from "../state/host-query-scope";
import { useEnvironmentQuery } from "../state/query";
import { useComposerDraftProject } from "../state/use-composer-drafts";
import { solus, useSolusShellCachesRead, useSolusWorkspace } from "./runtime";
import { sessionDetailAtom } from "./session-detail";
import { linkedSessionRecord } from "./session-record";
import { waitingForSessionList } from "./workspace-state";

const subscribeNothing = () => () => {};
const noSession = Atom.make(null);
const waitingForCodebase = Symbol("waitingForCodebase");
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export function useThreadSession(params: {
  environmentId?: string;
  threadId?: string;
  draft?: NewTaskDraftRouteParams;
  inspector?: ReactNavigation.RootParamList["Thread"]["inspector"];
}) {
  const directory = useSolusWorkspace();
  const draft = params.draft;
  const draftId = first(draft?.draftId);
  const draftProjectId = first(draft?.projectId);
  const draftEnvironmentId = first(draft?.environmentId);
  const savedProject = useComposerDraftProject(draftId);
  const savedCodebaseId = savedProject?.environmentId === draftEnvironmentId &&
    savedProject?.projectId === draftProjectId ? savedProject?.codebaseId : undefined;
  const newId = useMemo(
    () => solus.newSessionId(),
    [draft?.requestId, draftId, draftProjectId, draftEnvironmentId],
  );
  const hostId =
    params.environmentId ?? draftEnvironmentId ?? directory.environments[0]?.environmentId;
  const host = hostId ? directory.hostsById[hostId] : undefined;
  const id = params.threadId ?? newId;
  const path =
    draftProjectId ??
    directory.projects.find((p) => p.environmentId === hostId)?.workspaceRoot ??
    "~";
  const codebaseId = useListened(solus.codebases.changes, () => {
    if (savedCodebaseId == null || !hostId) return savedCodebaseId;
    if (solus.codebases.codebasesOfFolder(hostId, path).some(({ id }) => id === savedCodebaseId))
      return savedCodebaseId;
    const host = solus.codebases.hosts().find((host) => host.hostId === hostId);
    return host?.isReady && (host.status === null || host.status === "loading")
      ? waitingForCodebase : undefined;
  });
  const record = useSyncExternalStore(solus.threads.changes.subscribe, () =>
    hostId ? solus.threads.thread(hostId, id)?.record : undefined,
  );
  const waitingForHostList = useSyncExternalStore(
    solus.threads.changes.subscribe,
    () => !!hostId && waitingForSessionList(solus.threads.stateOf(hostId)),
  );
  const localCacheRead = useSolusShellCachesRead(hostId);
  const scope = useSyncExternalStore(solus.account.changes.subscribe, solus.sessionCache.scope);
  const [session, setSession] = useState(() => ({
    scope,
    store: hostId ? solus.openConversation(hostId, id) : null,
  }));
  const isDraft = !!draft;
  const saved = useAtomValue(hostId && !draft ? sessionDetailAtom(hostId, id) : noSession);
  const store = draft ? (session.scope === scope ? session.store : null) : saved;
  // Existing sessions reuse the navigation watch. A direct link can name a record
  // outside both directory pages, so read that exact session once after cache restore.
  const lookup = useEnvironmentQuery(
    !draft && !store && hostId && params.threadId && localCacheRead &&
      host?.connectionState === "connected"
      ? linkedSessionRecord({ environmentId: EnvironmentId.make(hostId), input: params.threadId })
      : null,
  );
  useEffect(() => {
    if (!isDraft || !hostId) return;
    const existing = solus.openConversation(hostId, id) ?? solus.conversation(hostId, {
      newSession: { sessionId: id, workingDirectory: path, provider: solus.personal.current().activeAgent },
    });
    setSession({ scope, store: existing });
    return existing ? solus.observeConversation(existing) : undefined;
  }, [scope, hostId, id, isDraft, path]);
  // Apply the saved choice before the user can send, with the existing draft observation in place.
  useLayoutEffect(() => {
    if (!isDraft || !store || codebaseId === undefined || codebaseId === waitingForCodebase) return;
    const { controller } = store;
    if (controller.hostId !== hostId || controller.run.sessionId !== id) return;
    if (!controller.isCodebasePicked || (controller.run.codebaseId ?? null) !== codebaseId)
      controller.chooseCodebase(codebaseId);
  }, [store, isDraft, codebaseId, hostId, id]);
  const readScope = useAtomValue(hostId ? hostQueryScopeAtom(hostId) : noSession);
  const readTurnDiff = useMemo(() => {
    if (!store || !hostId) return null;
    return (index: number) => hostQueryScope(hostId) === readScope
      ? store.controller.readTurnDiff(index)
      : Promise.resolve(null);
  }, [store, hostId, readScope]);
  // Mount the feed, composer and their host reads together when the first rows arrive.
  const openingHistory = useSyncExternalStore(
    saved?.meta.subscribe ?? subscribeNothing,
    () => !!saved && saved.controller.phase.kind === "loading" &&
      !saved.controller.showsHostConversation && saved.orderSnapshot().length === 0,
  );
  if (openingHistory && !params.inspector && host?.connectionState === "connected") return { kind: "loading" as const };
  if (isDraft && !record && codebaseId === waitingForCodebase) return { kind: "loading" as const };
  if (
    !store ||
    !hostId ||
    store.controller.run.sessionId !== id ||
    store.controller.hostId !== hostId
  ) {
    const isLoadingConnections = directory.state.isLoadingConnections;
    const connectionState =
      hostId && solus.connections.state(hostId)?.readiness === "reconnecting"
        ? "reconnecting"
        : (host?.connectionState ?? "available");
    const opening = draft
      ? isLoadingConnections || connectionState === "connecting" ||
        connectionState === "reconnecting" || connectionState === "connected"
      : threadRouteIsHydrating({
          isLoadingConnections,
          environmentRegistered: !!host && !!params.threadId,
          localCacheRead,
          connectionState,
          shellStatus: waitingForHostList ? "synchronizing" : "live",
          shellHasError: false, // The exact detail read can succeed after a list read fails.
          detailStatus: lookup.isPending ? "synchronizing" : "empty",
          detailHasError: lookup.error !== null && !lookup.isPending,
        });
    return opening
      ? { kind: "loading" as const }
      : {
          kind: "unavailable" as const,
          detail: draft
            ? directory.state.shellSnapshotError ?? undefined
            : lookup.error ?? host?.connectionError ?? undefined,
          recovery: !draft && hostId && host && params.threadId
            ? connectionState === "connected"
              ? { kind: "retry" as const, run: lookup.refresh }
              : { kind: "reconnect" as const, run: () => solus.connections.retry(hostId) }
            : undefined,
          hostId,
        };
  }
  return {
    kind: "ready" as const,
    readTurnDiff,
    store,
    hostId,
    id,
    draftKey: draftId,
    isDraft: !!draft,
    saved: !!record,
  };
}

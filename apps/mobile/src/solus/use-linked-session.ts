import { useAtomValue } from "@effect/atom-react";
import type { LinkedThreadTarget } from "@t3tools/client-runtime/linked-thread";
import { TranscriptModel } from "@solus-mobile/features/conversation/lib/transcript-model";
import { Atom } from "effect/reactivity";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { hostQueryScopeAtom } from "../state/host-query-scope";
import { mobileHost } from "../state/mobile-host";
import { useEnvironmentQuery } from "../state/query";
import { conversationFeed } from "./conversation-feed";
import { solus } from "./runtime";
import { sessionDetailAtom } from "./session-detail";
import { linkedSessionRecord } from "./session-record";
import { useMachineLinks } from "./use-machine-links";

const noStore = Atom.make(null);
const emptyOrder: readonly string[] = [];
const subscribeNothing = () => () => {};
const noMeta = () => null;
const noOrder = () => emptyOrder;

export function useLinkedSession(target: LinkedThreadTarget, active: boolean, parentSessionId?: string) {
  const { environmentId, threadId } = target;
  const scope = useAtomValue(hostQueryScopeAtom(environmentId));
  const sourceScope = useAtomValue(hostQueryScopeAtom(target.viaEnvironmentId));
  const via = useAtomValue(mobileHost(target.viaEnvironmentId));
  const isLinked = useMachineLinks().some(({ info, snapshot }) => info.installationId === target.viaEnvironmentId &&
    snapshot?.hosts.some(({ listing }) => listing.installationId === environmentId));
  const host = useAtomValue(mobileHost(environmentId));
  const record = useEnvironmentQuery(
    host && active ? linkedSessionRecord({ environmentId, input: threadId }) : null,
  );
  const store = useAtomValue(
    host && record.data ? sessionDetailAtom(environmentId, threadId) : noStore,
  );
  const meta = useSyncExternalStore(
    store?.meta.subscribe ?? subscribeNothing,
    store?.metaSnapshotOf ?? noMeta,
  );
  const order = useSyncExternalStore(
    store?.order.subscribe ?? subscribeNothing,
    store?.orderSnapshot ?? noOrder,
  );
  const cloud = useSyncExternalStore(
    solus.cloudSessions.changes.subscribe,
    () => solus.cloudSessions.connection,
  );
  const provider = useSyncExternalStore(
    solus.cloudSessions.changes.subscribe,
    () => solus.cloudSessions.recordFor(threadId)?.provider,
  );
  const [attempt, setAttempt] = useState(0);
  const [copy, setCopy] = useState<{
    scope: string;
    cloud: typeof cloud;
    id: string;
    relay?: { via: NonNullable<typeof via>; scope: string; parentSessionId?: string; isLinked: boolean };
    model?: TranscriptModel;
    title?: string | null;
    error?: string;
    paging?: boolean;
  }>();
  const mirror =
    !host && copy?.scope === scope && copy.id === threadId && copy.cloud === cloud &&
      (!copy.relay || (copy.relay.via === via && copy.relay.scope === sourceScope &&
        copy.relay.parentSessionId === parentSessionId && copy.relay.isLinked === isLinked))
      ? copy
      : undefined;
  useEffect(() => {
    if (host || !active || ((!cloud || !provider) && (!via || (!parentSessionId && !isLinked)))) return;
    let current = true;
    const read = async () => {
      const relay = via && (parentSessionId || isLinked) ? { via, scope: sourceScope, parentSessionId, isLinked } : undefined;
      try {
        if (cloud && provider) {
          try {
            const model = await solus.cloudHistory.read(threadId, provider);
            if (model.order.length > 0 || !relay) {
              if (current) setCopy({ scope, cloud, id: threadId, model });
              return;
            }
          } catch (error) {
            if (!relay) throw error;
          }
        }
        if (!current || !relay) return;
        const model = new TranscriptModel(threadId);
        const read = relay.isLinked
          ? await relay.via.api.hostsLinkedSessionPage(environmentId, threadId, null, 12)
          : { page: await relay.via.api.sessionLineageHistory(relay.parentSessionId!, threadId, undefined, 12), meta: null };
        model.prependHistory(read.page);
        if (current) setCopy({ scope, cloud, id: threadId, model, relay, title: read.meta?.customTitle ?? read.meta?.slug });
      } catch {
        if (current) setCopy({ scope, cloud, id: threadId, relay, error: "Could not read this session." });
      }
    };
    void read();
    return () => {
      current = false;
    };
  }, [scope, sourceScope, cloud, provider, host, via, parentSessionId, isLinked, environmentId, active, threadId, attempt]);

  const source = useMemo(
    () =>
      store ??
      (mirror?.model && {
        item: (key: string) => mirror.model?.items.get(key),
        subscribeFeedItems: subscribeNothing,
      }),
    [store, mirror?.model],
  );
  const project = useMemo(
    () =>
      source &&
      conversationFeed(
        source,
        threadId,
        () => null,
        async () => {
          throw new Error("Open this session to view the attachment.");
        },
        async (key) => {
          if (store) return store.controller.readToolInput(key);
          throw new Error("This tool input is available on the host.");
        },
      ),
    [source, threadId, store],
  );
  const sequence = mirror?.model?.order ?? order;
  const reader = useMemo(() => project?.(sequence), [project, sequence]);
  const feed = useSyncExternalStore(
    reader?.subscribe ?? subscribeNothing,
    reader?.get ?? (() => emptyFeed),
  );

  const loadEarlier = async () => {
    if (store) return store.controller.loadOlder();
    if (!mirror?.model || mirror.paging) return;
    const pending = { ...mirror, paging: true, error: undefined };
    setCopy(pending);
    try {
      const relay = mirror.relay;
      const cursor = mirror.model.olderCursor;
      if (relay && cursor) {
        const page = relay.isLinked
          ? (await relay.via.api.hostsLinkedSessionPage(environmentId, threadId, cursor, 12)).page
          : await relay.via.api.sessionLineageHistory(relay.parentSessionId!, threadId, cursor, 12);
        mirror.model.prependHistory(page);
      } else await solus.cloudHistory.readOlder(mirror.model);
      setCopy((current) => (current === pending ? { ...pending, paging: false } : current));
    } catch (error) {
      setCopy((current) =>
        current === pending ? { ...pending, paging: false, error: String(error) } : current,
      );
    }
  };
  return {
    connected: !!host,
    relayed: !!mirror?.relay,
    canOpen: !!store && store.controller.mayDrive,
    feed,
    ready: !!mirror?.model || meta?.phase.kind === "ready" || feed.length > 0,
    title: record.data?.customTitle ?? record.data?.title ?? mirror?.title,
    working: meta?.status === "running",
    hasOlder: meta?.hasOlder ?? !!mirror?.model?.olderCursor,
    paging: meta?.loadingOlder ?? mirror?.paging,
    error:
      record.error ??
      (meta?.phase.kind === "error" ? meta.phase.message : meta?.historyError) ??
      mirror?.error ??
      (!host && (!cloud || !provider) && (!via || (!parentSessionId && !isLinked)) ? "Connect to the host to read this session." : null),
    retry: () => {
      if (store) {
        if (meta?.historyError) void loadEarlier();
        else void store.controller.load();
      } else if (host) record.refresh();
      else if (mirror?.model) void loadEarlier();
      else setAttempt((n) => n + 1);
    },
    loadEarlier,
  };
}
const emptyFeed: ReturnType<ReturnType<ReturnType<typeof conversationFeed>>["get"]> = [];

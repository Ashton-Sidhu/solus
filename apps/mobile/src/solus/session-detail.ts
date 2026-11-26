import { Atom } from "effect/reactivity";
import { solus } from "./runtime";

/** Navigation and the mounted thread share the same account-scoped Solus read and watch. */
const sessionDetails = Atom.family((scope: string) =>
  Atom.family((hostId: string) =>
    Atom.family((sessionId: string) =>
      Atom.make((get) => {
        if (solus.sessionCache.scope() !== scope) return null;
        const thread = solus.threads.thread(hostId, sessionId);
        const retained = solus.openConversation(hostId, sessionId);
        const store = retained ?? (thread ? solus.conversation(hostId, { record: thread.record }) : null);
        if (store) get.addFinalizer(solus.observeConversation(store));
        else {
          get.addFinalizer(solus.threads.changes.subscribe(() => get.refreshSelf()));
          get.addFinalizer(solus.connections.changes.subscribe(() => get.refreshSelf()));
        }
        return store;
      }).pipe(Atom.setIdleTTL(0)),
    ),
  ),
);

const sessionCacheScopeAtom = Atom.make((get) => {
  get.addFinalizer(solus.account.changes.subscribe(() => get.setSelf(solus.sessionCache.scope())));
  return solus.sessionCache.scope();
});

const currentSessionDetails = Atom.family((hostId: string) =>
  Atom.family((sessionId: string) =>
    Atom.make((get) => get(sessionDetails(get(sessionCacheScopeAtom))(hostId)(sessionId)))
      .pipe(Atom.setIdleTTL(0)),
  ),
);

export function sessionDetailAtom(hostId: string, sessionId: string) {
  return currentSessionDetails(hostId)(sessionId);
}

// A sheet reads the same watch as its conversation and releases it when the sheet closes.
export function atomFromConversation<A>(
  select: (store: NonNullable<ReturnType<typeof solus.openConversation>>) => () => A,
) {
  const family = Atom.family((detail: ReturnType<typeof sessionDetailAtom>) =>
    Atom.make((get) => {
      const store = get(detail);
      if (!store) return null;
      const read = select(store);
      get.addFinalizer(store.meta.subscribe(() => get.setSelf(read())));
      return read();
    }).pipe(Atom.setIdleTTL(0)),
  );
  return (hostId: string, sessionId: string) => family(sessionDetailAtom(hostId, sessionId));
}

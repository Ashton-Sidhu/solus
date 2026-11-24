import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { solus } from "../solus/runtime";

export function hostQueryScope(hostId: string) {
  const host = solus.connections.state(hostId);
  return JSON.stringify([
    solus.sessionCache.scope(),
    host?.sessionGeneration,
    host?.readiness,
    host?.readiness === "ready" && solus.connections.may(hostId, "host.use"),
  ]);
}

export const hostQueryScopeAtom = Atom.family((hostId: string) =>
  Atom.make((get) => {
    let current = hostQueryScope(hostId);
    const update = () => {
      const next = hostQueryScope(hostId);
      if (next === current) return;
      current = next;
      get.setSelf(next);
    };
    get.addFinalizer(solus.account.changes.subscribe(update));
    get.addFinalizer(solus.connections.changes.subscribe(update));
    return current;
  }),
);

export function useHostQueryScope(hostId: string) {
  return useAtomValue(hostQueryScopeAtom(hostId));
}

const scopes = Atom.family((idsKey: string) =>
  Atom.make((get) => {
    const ids: string[] = JSON.parse(idsKey);
    return ids.map((id) => get(hostQueryScopeAtom(id)));
  }),
);

/** Retained pages and in-flight operations belong to the account and connection that requested them. */
export function useHostQueryTargets<T extends { readonly environmentId: string }>(
  targets: readonly T[],
) {
  const keys = useAtomValue(scopes(JSON.stringify(targets.map((target) => target.environmentId))));
  return targets.map((target, index) => ({ ...target, scope: keys[index]! }));
}

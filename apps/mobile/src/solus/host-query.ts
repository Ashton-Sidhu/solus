import type { EnvironmentId } from "@t3tools/contracts";
import { isWaitingForHost } from "@solus/client-core/host-readiness";
import { HostOperationError } from "./host-operation-error";
import { hostQueryScope, hostQueryScopeAtom } from "../state/host-query-scope";
import {
  EnvironmentQueryStore,
  readPersistedQuery,
  type QueryPersistence,
} from "@t3tools/client-runtime/state/query-persistence";
import { solus } from "./runtime";
import { queryPersistenceKey, revalidateOnMount } from "@t3tools/client-runtime/state/runtime";
import { reuseUnchanged } from "@t3tools/client-runtime/state/server-projection";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Effect from "effect/Effect";

export function hostQuery<I, A>(
  read: (hostId: string, input: I) => Promise<A>,
  options:
    | number
    | { label: string; persistence: QueryPersistence<A>; staleTimeMs?: number } = 30_000,
  idleTtlMs = 5 * 60_000,
) {
  const staleTimeMs = typeof options === "number" ? options : (options.staleTimeMs ?? 30_000);
  const family = Atom.family((key: string) => {
    const [hostId, input, scope]: [EnvironmentId, I, string] = JSON.parse(key);
    return Atom.make((get) => {
      const previous = Option.flatMap(
        get.self<AsyncResult.AsyncResult<A, Error>>(),
        AsyncResult.value,
      );
      let shown = Option.getOrUndefined(previous);
      const current = () => scope === hostQueryScope(hostId);
      const mayReadCache = () => {
        const { readiness } = solus.connections.readiness(hostId);
        return (
          readiness !== "gone" &&
          readiness !== "refused" &&
          solus.connections.may(hostId, "host.use")
        );
      };
      const changed = () => new HostOperationError({ message: "The host connection changed." });
      const answer = () =>
        Effect.tryPromise({
          try: async () => {
            if (!current()) throw changed();
            const value = await read(hostId, input);
            if (!current()) throw changed();
            return reuseUnchanged(shown, value);
          },
          catch: HostOperationError.from,
        });
      if (typeof options === "number") return answer();

      const readiness = solus.connections.readiness(hostId).readiness;
      if (!current()) return Effect.fail(changed());
      if (!mayReadCache())
        return Effect.fail(
          new HostOperationError({ message: "Pull requests are unavailable for this host." }),
        );
      const accountScope = solus.sessionCache.scope();
      return readPersistedQuery({
        persistence: options.persistence,
        environmentId: hostId,
        key: queryPersistenceKey(options.label, [accountScope, input]),
        previous,
        connected: readiness === "ready",
        answer: isWaitingForHost(readiness) ? () => Effect.never : answer,
        emit: (value) =>
          Effect.sync(() => {
            shown = value;
            get.setSelf(AsyncResult.success(value, { waiting: true }));
          }),
      }).pipe(
        Effect.provideService(EnvironmentQueryStore, {
          load: (id, cacheKey) =>
            Effect.promise(async () => {
              const payload = await solus.pullRequestCache.read<string>(id, cacheKey);
              return current() && mayReadCache() ? Option.fromNullishOr(payload) : Option.none();
            }),
          save: (id, cacheKey, payload) =>
            Effect.promise(async () => {
              if (current() && mayReadCache())
                await solus.pullRequestCache.write(id, cacheKey, payload);
            }),
        }),
      );
    }).pipe(Atom.setIdleTTL(idleTtlMs), revalidateOnMount(staleTimeMs));
  });
  const current = Atom.family((key: string) => {
    const [id, input]: [EnvironmentId, I] = JSON.parse(key);
    const scoped = (scope: string) => family(JSON.stringify([id, input, scope]));
    return Atom.readable(
      (get) => get(scoped(get(hostQueryScopeAtom(id)))),
      (refresh) => refresh(scoped(hostQueryScope(id))),
    );
  });
  return (target: { environmentId: EnvironmentId; input: I; scope?: string }) =>
    target.scope === undefined
      ? current(JSON.stringify([target.environmentId, target.input]))
      : family(JSON.stringify([target.environmentId, target.input, target.scope]));
}

import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { SessionShellStore } from "@solus-mobile/features/threads/session-shell";
import { runtime } from "../lib/runtime";
import { MobileDatabase } from "../persistence/mobile-database";

/**
 * The session shell of each host in T3's device table `client_cache`, kind
 * `shell`, through T3's `MobileDatabase` (docs/plans/mobile-session-shell.md
 * §3). One record for each host and account scope: the scope is in the key,
 * so a record of one account is never read in another. The key has its own
 * prefix, so it does not meet T3's own shell record (`snapshot`).
 */
const SCHEMA_VERSION = 1;
const cacheKey = (scope: string) => `solus-session-shell:v${SCHEMA_VERSION}:${scope}`;

const withDatabase = <A, E>(use: (database: MobileDatabase["Service"]) => Effect.Effect<A, E>) =>
  runtime.runPromise(MobileDatabase.pipe(Effect.flatMap(use)));

export const sessionShellStore: SessionShellStore = {
  load: (hostId, scope) =>
    withDatabase((database) => database.loadCache(EnvironmentId.make(hostId), "shell", cacheKey(scope))).then(
      Option.getOrNull,
    ),
  save: (hostId, scope, payload) =>
    withDatabase((database) =>
      database.saveCache(EnvironmentId.make(hostId), "shell", cacheKey(scope), SCHEMA_VERSION, payload),
    ),
  forget: (hostId) => withDatabase((database) => database.clearCacheKind(EnvironmentId.make(hostId), "shell")),
};

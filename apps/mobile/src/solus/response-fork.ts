import { useSyncExternalStore } from "react";
import { useAtomValue } from "@effect/atom-react";
import { resourceAllows } from "@solus/contracts/permissions";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Effect, Layer } from "effect";
import { Atom } from "effect/reactivity";
import { hostQueryScope } from "../state/host-query-scope";
import { mobileHost } from "../state/mobile-host";
import { startOpeningEnvironmentThread } from "../state/threads";
import { solus } from "./runtime";
import { rememberSession } from "./session-record";
import { HostOperationError } from "./host-operation-error";

interface ResponseForkInput {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  sourceThreadId: ThreadId;
  targetThreadId: ThreadId;
  pointId: string;
}

export const forkSolusResponse = createRuntimeCommand(Atom.runtime(Layer.empty), {
  label: "mobile:fork-from-response",
  concurrency: {
    mode: "serial",
    key: (input: ResponseForkInput) => JSON.stringify([input.environmentId, input.threadId]),
  },
  execute: (input: ResponseForkInput) =>
    Effect.tryPromise({
      try: async () => {
        const { environmentId, threadId, sourceThreadId, targetThreadId, pointId } = input;
        const connection = solus.connections.connection(environmentId);
        if (connection?.state.readiness !== "ready") throw new Error("Reconnect to this environment.");
        const scope = hostQueryScope(environmentId);
        const fork = await connection.api.forkSessionFromResponse({
          sessionId: threadId,
          sourceThreadId,
          targetSessionId: targetThreadId,
          pointId,
        });
        if (scope !== hostQueryScope(environmentId)) throw new Error("The connection changed.");
        await rememberSession(environmentId, targetThreadId, fork);
        if (scope !== hostQueryScope(environmentId)) throw new Error("The connection changed.");
        startOpeningEnvironmentThread(environmentId, targetThreadId);
      },
      catch: HostOperationError.from,
    }),
});

export function useCanForkSolusResponse(environmentId: EnvironmentId, threadId: ThreadId, hasPoint: boolean) {
  const host = useAtomValue(mobileHost(environmentId));
  return useSyncExternalStore(solus.threads.changes.subscribe, () => {
    if (!hasPoint || !host || !solus.connections.may(environmentId, "host.sessions.start")) return false;
    const record = solus.threads.thread(environmentId, threadId)?.record;
    return !!record && resourceAllows(record, "drive.prompt");
  });
}

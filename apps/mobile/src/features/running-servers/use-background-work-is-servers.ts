import { useEffect, useSyncExternalStore } from "react";
import type { OrchestrationV2PendingBackgroundTask } from "@t3tools/contracts";
import { agentServersOf, backgroundWorkIsServers } from "@solus/client-core/background-work";
import { solus } from "../../solus/runtime";
import { runningServersFor } from "./running-servers-store";

/**
 * Whether the thread's background line can stay out: the person turned on
 * `hideServerBackgroundWork`, and the only work still running is servers the
 * thread's agent started, which its Running servers sheet shows and stops.
 * The host's server list is read only while that question is open.
 */
export function useBackgroundWorkIsServers(
  hostId: string,
  threadId: string,
  tasks: readonly OrchestrationV2PendingBackgroundTask[],
): boolean {
  const hidesServers = useSyncExternalStore(
    solus.personal.changes.subscribe,
    () => solus.personal.current().hideServerBackgroundWork,
  );
  const isAwaited = tasks.some((task) => task.awaited);
  const isAsking = hidesServers && !isAwaited && tasks.length > 0 && tasks.every((task) => task.kind === "command");
  const store = runningServersFor(hostId);
  // The revision changes whenever the server list does, so this render reads the current list.
  useSyncExternalStore(store.subscribe, () => store.revision);
  useEffect(() => {
    if (isAsking) return store.retainCheckouts([]);
  }, [isAsking, store]);
  const serverCount = isAsking ? agentServersOf(store.servers, threadId).length : 0;
  return isAsking && backgroundWorkIsServers(isAwaited, tasks, serverCount);
}

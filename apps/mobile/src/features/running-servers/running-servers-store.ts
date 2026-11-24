import { RunningServersController } from "@solus/client-core/running-servers";
import { solus } from "../../solus/runtime";

const stores = new Map<string, RunningServersController>();

export function runningServersFor(hostId: string): RunningServersController {
  const existing = stores.get(hostId);
  if (existing) return existing;
  const store = new RunningServersController(
    () => {
      const connection = solus.connections.connection(hostId);
      if (connection?.state.readiness !== "ready" || !solus.connections.may(hostId, "host.use")) return null;
      return {
        api: connection.api,
        events: connection.events,
        ready: true,
        scope: JSON.stringify([solus.sessionCache.scope(), connection.state.sessionGeneration]),
      };
    },
    (changed) => {
      const stopConnection = solus.connections.changes.subscribe(changed);
      const stopAccount = solus.account.changes.subscribe(changed);
      return () => { stopConnection(); stopAccount(); };
    },
  );
  stores.set(hostId, store);
  return store;
}

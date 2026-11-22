import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
  KeyConnectionStore,
  type KeyConnectionState,
} from "@solus/client-core/key-connection-store";
import { useListened } from "@solus-mobile/app/app-context";
import { solus as app } from "./runtime";

const LINEAR_REF = { kind: "provider", provider: "linear" } as const;

/** The connection's status as one short value: "Checking…", the Linear user, or "Not connected". */
export function linearConnectionValue(state: KeyConnectionState): string {
  if (state.loading) return "Checking…";
  return state.connected ? (state.label ?? "Connected") : "Not connected";
}

/**
 * The person's Linear key, as the desktop Integrations page keeps it
 * (`KeyConnectionStore`): signed out, the host holds it; signed in, the Solus
 * account holds it, and the host moved any key it held there at sign-in.
 */
export function useLinearConnection(hostId: string) {
  const readiness = useListened(
    app.connections.changes,
    () => app.connections.state(hostId)?.readiness,
  );
  const identity = useListened(
    app.account.changes,
    () => app.account.syncAccount?.userId ?? "signed-out",
  );
  const store = useMemo(
    () =>
      new KeyConnectionStore(LINEAR_REF, {
        host: () => {
          const connection = app.connections.connection(hostId);
          if (!connection) throw new Error("This host is not connected.");
          return connection.api;
        },
        account: () => (app.account.isSignedIn ? app.account.agentProfileRequests() : null),
        identity: () => app.account.syncAccount?.userId ?? "signed-out",
      }),
    [app, hostId],
  );
  const state = useSyncExternalStore(store.subscribe, () => store.current);

  // A new account, or a host that is ready again, reads the connection again.
  useEffect(() => {
    if (readiness !== "ready") return;
    store.reset();
    void store.load();
  }, [store, identity, readiness]);

  return { state, store };
}

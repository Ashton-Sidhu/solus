import { useCallback, useRef, useSyncExternalStore } from "react";

import { useApp } from "../../app/app-context";
import { deriveWorkspaceState, type WorkspaceState } from "./workspace-connection-status";

/**
 * T3's `useWorkspaceState().state`, from the host registry, the host
 * connections, and the thread directory. The value keeps its identity until
 * one of its fields changes, so a reconnect elsewhere does not re-render the
 * list.
 */
export function useWorkspaceState(): WorkspaceState {
  const app = useApp();
  const cache = useRef<{ signature: string; state: WorkspaceState } | null>(null);
  const subscribe = useCallback(
    (listener: () => void) => {
      const stops = [
        app.registry.changes.subscribe(listener),
        app.connections.changes.subscribe(listener),
        app.threads.changes.subscribe(listener),
      ];
      return () => stops.forEach((stop) => stop());
    },
    [app],
  );
  const read = useCallback(() => {
    const state = deriveWorkspaceState(
      app.registry.hosts().map((host) => ({
        label: host.label,
        phase: app.connections.state(host.id)?.phase,
        threads: app.threads.stateOf(host.id),
      })),
    );
    const signature = JSON.stringify(state);
    if (cache.current?.signature !== signature) cache.current = { signature, state };
    return cache.current.state;
  }, [app]);
  return useSyncExternalStore(subscribe, read, read);
}

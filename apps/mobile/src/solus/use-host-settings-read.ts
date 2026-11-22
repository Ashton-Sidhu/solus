import { useCallback, useRef, useState } from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { useListened } from "@solus-mobile/app/app-context";
import type { HostApi } from "@solus/client-core/host-api";
import type { HostEventName } from "@solus/contracts/host-events";
import { solus } from "./runtime";

type Read<T> = (api: HostApi) => Promise<T>;

/** Keep settings reads bound to the visible page and the current host connection. */
export function useHostSettingsRead<T>(hostId: string, read: Read<T>, topic?: HostEventName) {
  const connection = useListened(solus.connections.changes, () =>
    solus.connections.connection(hostId),
  );
  const generation = useListened(
    solus.connections.changes,
    () => solus.connections.state(hostId)?.sessionGeneration,
  );
  const ready = useListened(
    solus.connections.changes,
    () => solus.connections.state(hostId)?.readiness === "ready",
  );
  const [result, setResult] = useState<{
    key: string;
    data?: T;
    error?: string;
  }>();
  const [refreshId, setRefreshId] = useState(0);
  const accountScope = useListened(solus.account.changes, solus.sessionCache.scope);
  const key = JSON.stringify([accountScope, hostId, generation]);
  const request = useRef(0);
  useFocusEffect(
    useCallback(() => {
      if (!ready || !connection) return;
      const api = connection.api;
      function refresh() {
        const version = ++request.current;
        void read(api).then(
          (data) => {
            if (version === request.current) setResult({ key, data });
          },
          (error) => {
            if (version === request.current) setResult({ key, error: String(error) });
          },
        );
      }
      refresh();
      const stop = topic && connection.events.subscribe(topic, refresh);
      const active = AppState.addEventListener("change", (state) => {
        if (state === "active") refresh();
      });
      return () => {
        request.current++;
        active.remove();
        if (stop) stop();
      };
    }, [key, ready, connection, read, topic, refreshId]),
  );
  return {
    api: ready ? connection?.api : undefined,
    data: ready && result?.key === key ? result.data : undefined,
    error: !ready
      ? "Reconnect to this environment."
      : result?.key === key
        ? result.error
        : undefined,
    refresh: () => setRefreshId((id) => id + 1),
  };
}

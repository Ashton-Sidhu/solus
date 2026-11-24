import { useMemo } from "react";
import { AppState } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { useAtomValue } from "@effect/atom-react";
import type { HostApi } from "@solus/client-core/host-api";
import type { HostEventName } from "@solus/contracts/host-events";
import { EnvironmentId } from "@t3tools/contracts";
import { Atom, type AsyncResult } from "effect/reactivity";
import { mobileHost } from "../state/mobile-host";
import { useEnvironmentQuery } from "../state/query";
import { hostQuery } from "./host-query";
import { solus } from "./runtime";

type Read<T> = (api: HostApi) => Promise<T>;

/** Follow host events only while a page reads this setting. Reopening shows its last answer during refresh. */
export function useHostSettingsRead<T>(hostId: string, read: Read<T>, topic?: HostEventName, enabled = true) {
  const environmentId = EnvironmentId.make(hostId);
  const queryForHost = useMemo(
    () =>
      hostQuery((id, _input: null) => {
        const connection = solus.connections.connection(id);
        if (connection?.state.readiness !== "ready")
          throw new Error("Reconnect to this environment.");
        return read(connection.api);
      }, 0),
    [read],
  );
  return useHostQueryRead(environmentId, queryForHost({ environmentId, input: null }), topic, enabled);
}

export function useHostQueryRead<T>(
  environmentId: EnvironmentId,
  source: Atom.Atom<AsyncResult.AsyncResult<T, Error>>,
  topic?: HostEventName,
  enabled = true,
) {
  const host = useAtomValue(mobileHost(environmentId));
  const focused = useIsFocused();
  const observed = useMemo(
    () =>
      Atom.readable(
        (get) => {
          if (topic && host)
            get.addFinalizer(host.events.subscribe(topic, () => get.refresh(source)));
          const active = AppState.addEventListener("change", (state) => {
            if (state === "active") get.refresh(source);
          });
          get.addFinalizer(() => active.remove());
          return get(source);
        },
        (refresh) => refresh(source),
      ).pipe(Atom.setIdleTTL(0)),
    [source, host, topic],
  );
  const query = useEnvironmentQuery(enabled && focused && host ? observed : null);
  return {
    api: host?.api,
    data: query.isSuccess ? query.data : undefined,
    error: host ? (query.error ?? undefined) : "Reconnect to this environment.",
    isRefreshing: query.isSuccess && query.isPending,
    refresh: query.refresh,
  };
}

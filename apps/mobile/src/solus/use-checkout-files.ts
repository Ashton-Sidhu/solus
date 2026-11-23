import { useAtomValue } from "@effect/atom-react";
import { useListened } from "@solus-mobile/app/app-context";
import { solus, useSolusWorkspace } from "./runtime";
import { waitingForSessionList } from "./workspace-state";
import { fileAccountScope } from "../state/mobile-host";

export function useCheckoutAccess(hostId: string | null) {
  const accountKey = useAtomValue(fileAccountScope).key;
  const { hostsById, state } = useSolusWorkspace();
  const status = hostId ? hostsById[hostId]?.connectionState : undefined;
  const mayRead = useListened(
    solus.connections.changes,
    () => !!hostId && solus.connections.may(hostId, "host.files.read"),
  );
  return {
    accountKey,
    canReadFiles: status === "connected" && mayRead,
    isPending: state.isLoadingConnections || status === "connecting" || status === "reconnecting",
    error: status === "connected" ? null : "Reconnect to this environment.",
  };
}

export function useCheckoutLocation(hostId: string | null, threadId: string | null) {
  const read = () =>
    hostId && threadId ? solus.threads.thread(hostId, threadId)?.record : undefined;
  const record = useListened(solus.threads.changes, read);
  const pending = useListened(
    solus.threads.changes,
    () => !!hostId && !!threadId && waitingForSessionList(solus.threads.stateOf(hostId)),
  );
  return { cwd: record?.cwd || record?.projectPath, pending: pending && !record };
}

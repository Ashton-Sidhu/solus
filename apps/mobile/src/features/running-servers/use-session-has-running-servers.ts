import { useIsFocused } from "@react-navigation/native";
import { runningServerFolderPaths } from "@solus/client-core/running-servers";
import type { SessionFolder } from "@solus/contracts/codebases";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { runningServersFor } from "./running-servers-store";

export function useSessionHasRunningServers(
  hostId: string,
  sessionId: string,
  workingDirectory: string,
  folders: readonly SessionFolder[],
  enabled: boolean,
): boolean {
  const focused = useIsFocused();
  const store = runningServersFor(hostId);
  const checkoutPaths = useMemo(() => runningServerFolderPaths(workingDirectory, folders), [workingDirectory, folders]);
  const subscribe = useCallback((changed: () => void) => {
    if (!enabled || !focused) return () => {};
    const unsubscribe = store.subscribe(changed);
    const release = store.retainCheckouts(checkoutPaths);
    return () => { unsubscribe(); release(); };
  }, [enabled, focused, store, checkoutPaths]);
  return useSyncExternalStore(subscribe, () =>
    enabled && focused && store.status === "ready" && store.rowsForScope({ checkoutPaths, sessionId }).sessionRows.length > 0,
  );
}

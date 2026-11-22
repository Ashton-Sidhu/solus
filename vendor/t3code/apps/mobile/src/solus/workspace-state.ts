import type { HostThreadsState } from "@solus-mobile/features/threads/thread-directory";
import {
  projectWorkspaceConnectionState,
  type WorkspaceEnvironment,
  type WorkspaceState,
} from "../state/workspaceModel";

export function waitingForSessionList(state: HostThreadsState) {
  return (
    state.kind === "idle" ||
    state.kind === "loading" ||
    (state.kind === "loaded" && state.value.indexing && state.value.threads.length === 0)
  );
}

export function solusWorkspaceState(
  environments: WorkspaceEnvironment[],
  stateOf: (hostId: string) => HostThreadsState,
  ready: boolean,
  loadError: string | null,
): WorkspaceState {
  let hasSnapshot = false;
  let pending = false;
  let syncing = false;
  let error = loadError;
  for (const env of environments) {
    const state = stateOf(env.environmentId);
    const previous =
      state.kind === "loaded" ? state.value : state.kind === "idle" ? null : state.previous;
    const indexing = previous?.indexing === true && previous.threads.length === 0;
    hasSnapshot ||= previous !== null && !indexing;
    const waiting = waitingForSessionList(state);
    pending ||= waiting && env.connectionState !== "offline";
    syncing ||= waiting && env.connectionState === "connected";
    if (state.kind === "error") error ??= state.message;
  }
  return {
    ...projectWorkspaceConnectionState({ isReady: ready, networkStatus: "unknown", environments }),
    hasLoadedShellSnapshot: hasSnapshot,
    hasPendingShellSnapshot: pending,
    hasSyncingConnectedEnvironment: syncing,
    shellSnapshotError: error,
  };
}

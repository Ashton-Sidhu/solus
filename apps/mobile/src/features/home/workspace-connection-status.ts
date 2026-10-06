// Adapted from T3 Code apps/mobile/src/features/home/workspace-connection-status.ts (MIT, see UPSTREAM.md).
import type { HostConnectionPhase } from "../hosts/host-connections";
import type { HostThreadsState } from "../threads/thread-directory";

/**
 * T3's workspace state, read from Solus hosts: a T3 environment is a Solus
 * host, and its "shell snapshot" is the host's session list
 * (`app.threads.stateOf`). Solus does not watch the device's network here, so
 * there is no "You are offline" state; a host that cannot be reached reads as
 * not connected.
 */
export interface WorkspaceState {
  readonly hasConnections: boolean;
  readonly hasReadyEnvironment: boolean;
  readonly hasConnectingEnvironment: boolean;
  readonly connectingEnvironments: ReadonlyArray<{ readonly environmentLabel: string }>;
  /** A connected host whose session list failed to read. */
  readonly connectionError: string | null;
  /** Some host's session list has been read. */
  readonly hasLoadedShellSnapshot: boolean;
  /** A connected host's session list is being read. */
  readonly hasPendingShellSnapshot: boolean;
}

export interface WorkspaceHostState {
  readonly label: string;
  readonly phase: HostConnectionPhase | undefined;
  readonly threads: HostThreadsState;
}

export function deriveWorkspaceState(hosts: ReadonlyArray<WorkspaceHostState>): WorkspaceState {
  const connected = hosts.filter((host) => host.phase === "connected");
  const connecting = hosts.filter(
    (host) => host.phase === "connecting" || host.phase === "reconnecting" || host.phase === undefined,
  );
  const failed = connected.find((host) => host.threads.kind === "error");
  return {
    hasConnections: hosts.length > 0,
    hasReadyEnvironment: connected.length > 0,
    hasConnectingEnvironment: connecting.length > 0,
    connectingEnvironments: connecting.map((host) => ({ environmentLabel: host.label })),
    connectionError: failed?.threads.kind === "error" ? failed.threads.message : null,
    hasLoadedShellSnapshot: hosts.some(
      (host) =>
        host.threads.kind === "loaded" ||
        ((host.threads.kind === "loading" || host.threads.kind === "error") &&
          host.threads.previous !== null),
    ),
    hasPendingShellSnapshot: connected.some(
      (host) => host.threads.kind === "idle" || host.threads.kind === "loading",
    ),
  };
}

export interface WorkspaceConnectionStatusPresentation {
  readonly label: string;
  /** True while actively working (connecting/syncing) — render a spinner. False for offline/error/idle states — render a wifi-slash icon. */
  readonly showsProgress: boolean;
}

function shouldShowWorkspaceConnectionStatus(state: WorkspaceState): boolean {
  return (
    state.connectionError !== null ||
    state.hasConnectingEnvironment ||
    state.hasPendingShellSnapshot ||
    (state.hasConnections && !state.hasReadyEnvironment)
  );
}

function workspaceConnectionStatusLabel(state: WorkspaceState): string {
  if (state.connectingEnvironments.length === 1) {
    return `Reconnecting to ${state.connectingEnvironments[0]!.environmentLabel}`;
  }
  if (state.connectingEnvironments.length > 1) {
    return `Reconnecting ${state.connectingEnvironments.length} hosts`;
  }
  if (state.connectionError !== null) return state.connectionError;
  if (state.hasPendingShellSnapshot) {
    return state.hasLoadedShellSnapshot ? "Syncing threads..." : "Loading threads...";
  }
  return "Not connected";
}

/** Header-title presentation of the connection state, or null while connected. */
export function workspaceConnectionStatusPresentation(
  state: WorkspaceState,
): WorkspaceConnectionStatusPresentation | null {
  if (!shouldShowWorkspaceConnectionStatus(state)) return null;
  return {
    label: workspaceConnectionStatusLabel(state),
    showsProgress:
      state.connectionError === null &&
      (state.connectingEnvironments.length > 0 || state.hasPendingShellSnapshot),
  };
}

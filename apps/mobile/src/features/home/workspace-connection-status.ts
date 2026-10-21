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
  /** No connected host can run work yet, and one is setting this person's workspace up (docs/plans/member-isolation.md §8.1). */
  readonly isSettingUpWorkspace: boolean;
}

export interface WorkspaceHostState {
  readonly label: string;
  readonly phase: HostConnectionPhase | undefined;
  readonly threads: HostThreadsState;
  /** The host is still making this person's Linux user and folders; absent: it is not. */
  readonly isPreparing?: boolean;
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
    isSettingUpWorkspace:
      connected.some((host) => host.isPreparing === true) && !connected.some((host) => host.isPreparing !== true),
  };
}

export interface WorkspaceConnectionStatusPresentation {
  readonly label: string;
  readonly kind: "progress" | "load-error" | "offline";
}

/**
 * While one host is connected the header keeps the brand: a second host that
 * retries or fails does not take it (pingdotgg/t3code#21388). Only a connected
 * host's own session list, loading or failed, shows. Each host's state stays
 * on the Hosts screen.
 */
function shouldShowWorkspaceConnectionStatus(state: WorkspaceState): boolean {
  if (state.hasReadyEnvironment) return state.connectionError !== null || state.hasPendingShellSnapshot;
  return (
    state.connectionError !== null ||
    state.hasConnectingEnvironment ||
    state.hasPendingShellSnapshot ||
    (state.hasConnections && !state.hasReadyEnvironment)
  );
}

/** The hosts the header names as reconnecting: none while another host is connected. */
function reconnectingHosts(state: WorkspaceState): WorkspaceState["connectingEnvironments"] {
  return state.hasReadyEnvironment ? [] : state.connectingEnvironments;
}

function workspaceConnectionStatusLabel(state: WorkspaceState): string {
  const reconnecting = reconnectingHosts(state);
  if (reconnecting.length === 1) {
    return `Reconnecting to ${reconnecting[0]!.environmentLabel}`;
  }
  if (reconnecting.length > 1) {
    return `Reconnecting ${reconnecting.length} hosts`;
  }
  if (state.connectionError !== null) return "Could not load threads";
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
    kind:
      reconnectingHosts(state).length > 0
        ? "progress"
        : state.connectionError !== null
          ? "load-error"
          : state.hasPendingShellSnapshot
            ? "progress"
            : "offline",
  };
}

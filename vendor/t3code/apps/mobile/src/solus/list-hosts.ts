import type { WorkspaceEnvironment } from "../state/workspaceModel";

export function solusListHosts(
  hosts: ReadonlyArray<Pick<WorkspaceEnvironment, "environmentId" | "connectionState">>,
) {
  // Keep cached rows on their shelf while the host reconnects.
  const supported = new Set(hosts.map((host) => host.environmentId));
  const connected = new Set(
    hosts.filter((host) => host.connectionState === "connected").map((host) => host.environmentId),
  );
  return {
    settlementEnvironmentIds: supported,
    snoozeEnvironmentIds: supported,
    pinningEnvironmentIds: supported,
    connectedEnvironmentIds: connected,
  };
}

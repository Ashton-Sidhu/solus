import type { WorkspaceEnvironment } from "../state/workspaceModel";

export function solusListHosts(
  hosts: ReadonlyArray<
    Pick<WorkspaceEnvironment, "environmentId" | "connectionState"> & {
      supportsListControls?: boolean;
    }
  >,
) {
  // Keep cached rows on their shelf while the host reconnects.
  const supported = new Set(hosts.map((host) => host.environmentId));
  const connected = new Set(
    hosts.filter((host) => host.connectionState === "connected").map((host) => host.environmentId),
  );
  return {
    listControlEnvironmentIds: new Set(
      hosts
        .filter((h) => h.supportsListControls && connected.has(h.environmentId))
        .map((h) => h.environmentId),
    ),
    settlementEnvironmentIds: supported,
    snoozeEnvironmentIds: supported,
    pinningEnvironmentIds: supported,
    connectedEnvironmentIds: connected,
  };
}

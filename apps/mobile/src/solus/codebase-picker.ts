import type { CodebaseHost } from "@solus-mobile/features/codebases/codebases";
import type { Codebase } from "@solus/contracts/codebases";
import { isInsideHostPath } from "@solus/contracts/host-path";

export interface DraftCodebaseContext {
  readonly hostId: string;
  readonly path: string;
  readonly codebaseId: string | null;
}

/** The folder a codebase opens on each known host. */
export function codebasePickerDestinations(
  codebase: Codebase,
  hosts: readonly CodebaseHost[],
  current?: DraftCodebaseContext,
) {
  return hosts.flatMap((host) => {
    const roots = codebase.roots.filter((root) =>
      root.installationId === host.installationId || root.installationId === host.hostId,
    );
    const first = roots[0];
    if (!first) return [];
    const currentPath = host.hostId === current?.hostId ? current.path : undefined;
    const holding = currentPath === undefined ? undefined : roots.find((root) =>
      isInsideHostPath(root.path, currentPath),
    );
    const path = currentPath !== undefined && holding && !holding.container
      ? currentPath
      : (holding ?? first).path;
    return [{ hostId: host.hostId, label: host.label, isReady: host.isReady, path, roots }];
  });
}

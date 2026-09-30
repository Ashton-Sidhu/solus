import type { HostApi } from '@solus/client-core/host-api'
import type { IpcContext } from '@solus/contracts/types'

/**
 * The heat map's `loadRepoFiles`: the project's indexed file list, so the map
 * draws the repository around the change and not only the changed slice. A
 * host that cannot list the folder leaves a changed-only map.
 */
export function repoFileLoader(
  api: () => HostApi,
  ctx: () => IpcContext,
): (repoRoot: string) => Promise<readonly string[] | null> {
  return async (repoRoot) => {
    const result = await api().listProjectFiles(ctx(), { cwd: repoRoot })
    return result.ok ? result.files : null
  }
}

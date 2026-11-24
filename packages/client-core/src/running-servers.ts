import { hostPathKey } from '@solus/contracts/host-path'

export { RunningServersController } from './running-servers/controller'
export { RunningServers, runningServerTunnelUrl } from './running-servers/running-servers'
export type { RunningServersScope, RunningServersSource, RunningServersStoreState } from './running-servers/controller'
export type { RunningServersRow } from './running-servers/running-servers'

/** Keep the working folder first, using the current checkout of every session folder. */
export function runningServerFolderPaths(
  workingDirectory: string | null | undefined,
  folders: readonly { path: string; granted: boolean }[] = [],
): string[] {
  const paths = new Map<string, string>()
  for (const path of [workingDirectory, ...folders.filter((folder) => folder.granted).map((folder) => folder.path)]) {
    if (!path || path === '~') continue
    const key = hostPathKey(path)
    if (!paths.has(key)) paths.set(key, path)
  }
  return [...paths.values()]
}

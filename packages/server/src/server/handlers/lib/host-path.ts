import { homedir } from 'os'
import { posix, resolve as pathResolve, win32 } from 'path'

/** `~` is expanded on the host that owns the filesystem being browsed. */
export function expandHome(
  rawPath: string,
  homeDirectory = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  const pathApi = platform === 'win32' ? win32 : posix
  if (rawPath === '~') return homeDirectory
  if (rawPath.startsWith('~/') || (platform === 'win32' && rawPath.startsWith('~\\'))) {
    return pathApi.join(homeDirectory, rawPath.slice(2))
  }
  return platform === process.platform ? pathResolve(rawPath) : pathApi.resolve(rawPath)
}

/**
 * The owned runtime layout under `SOLUS_RUNTIME_DIR` (default
 * `~/.local/share/solus`): immutable per-version installs under `versions/`,
 * and a `current` symlink naming the active one. `current` is repointed with
 * a rename, which POSIX guarantees is atomic, so a reader never observes a
 * half-updated link.
 *
 * On Windows `current` is a directory junction, which needs no privilege
 * (`docs/plans/windows.md` §5.7). A rename over a junction fails with EPERM,
 * so the old junction is removed and the new one is made in its place.
 */
import { existsSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { renameRetrying } from './rename-retry'

export function versionsDir(runtimeDir: string): string {
  return join(runtimeDir, 'versions')
}

export function versionDir(runtimeDir: string, version: string): string {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid release version.')
  return join(versionsDir(runtimeDir), version)
}

export function currentLink(runtimeDir: string): string {
  return join(runtimeDir, 'current')
}

/** Null when no version has been activated yet. */
export function currentVersionDir(runtimeDir: string): string | null {
  const link = currentLink(runtimeDir)
  if (!existsSync(link)) return null
  return realpathSync(link)
}

/** The version this runtime dir currently targets, from the `current` symlink's
 *  own text (not its realpath), so it reads even if the target was removed. */
export function currentVersionName(runtimeDir: string): string | null {
  const link = currentLink(runtimeDir)
  if (!existsSync(link)) return null
  try {
    return basename(readlinkSync(link))
  } catch {
    return null
  }
}

/** Repoints `current` at `versions/<version>`, which must already exist. */
export function activateVersion(runtimeDir: string, version: string, platform: NodeJS.Platform = process.platform): void {
  const target = versionDir(runtimeDir, version)
  if (!existsSync(target)) throw new Error(`Version ${version} is not installed at ${target}`)
  const link = currentLink(runtimeDir)
  if (platform === 'win32') {
    // unlink removes the junction itself, never the version it names.
    try { unlinkSync(link) } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    symlinkSync(target, link, 'junction')
    return
  }
  const staged = `${link}.next-${process.pid}`
  rmSync(staged, { force: true })
  symlinkSync(target, staged)
  renameSync(staged, link)
}

export function removeVersion(runtimeDir: string, version: string): void {
  rmSync(versionDir(runtimeDir, version), { recursive: true, force: true })
}

/** Moves a verified, extracted release from its download staging directory
 *  into `versions/<version>`, then discards the rest of the staging dir. */
export function finalizeStagedVersion(stagedDir: string, runtimeDir: string, version: string): void {
  renameRetrying(stagedDir, versionDir(runtimeDir, version))
  rmSync(dirname(stagedDir), { recursive: true, force: true })
}

/** Removes `.download-*` staging directories left behind by a download that
 *  never finished (the process crashed before `finalizeStagedVersion` moved
 *  it out). Only safe to call while holding the supervisor lock, so no
 *  in-flight download can be mid-write when this runs. */
export function pruneStaleDownloads(runtimeDir: string): void {
  const dir = versionsDir(runtimeDir)
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.download-')) rmSync(join(dir, entry), { recursive: true, force: true })
  }
}

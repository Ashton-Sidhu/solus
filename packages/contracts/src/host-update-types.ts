/**
 * A host's update status as every client sees it. The host owns it: it runs the
 * checks, spawns the provider binaries, asks the release sources, and
 * broadcasts each change on `host.updateStatusChanged`. Clients mirror it and
 * issue commands. Vocabulary: `docs/plans/host-and-provider-updates.md`.
 */
import type { SetupAgent } from './types'

/** How Solus got onto the host. Decides the remediation. */
export type HostInstallKind = 'desktop' | 'homebrew' | 'tarball' | 'source' | 'unknown'

/**
 * The desktop update states without `downloading` and `ready`: a host or a
 * provider is updated in place by a command the user runs, and the next check
 * confirms it.
 */
export type UpdateCheckState =
  /** Before the first check, or permanently when a check is not possible; `reason` says why. */
  | { kind: 'idle'; reason: string | null }
  | { kind: 'checking' }
  | { kind: 'up-to-date'; checkedAt: number }
  | { kind: 'available'; latestVersion: string; checkedAt: number }
  /** Keeps the last known latest version so a row can still say what it knew. */
  | { kind: 'error'; message: string; latestVersion: string | null; checkedAt: number }

export interface ProviderUpdateStatus {
  agent: SetupAgent
  /** Null when the CLI is absent or its version could not be read. */
  installedVersion: string | null
  check: UpdateCheckState
}

export interface HostUpdateStatus {
  currentVersion: string
  install: HostInstallKind
  /** The one action that brings Solus on this host up to date, in the user's
   *  words. Null for desktop and source installs; the row derives its own. */
  remediation: string | null
  releaseUrl: string | null
  check: UpdateCheckState
  providers: ProviderUpdateStatus[]
}

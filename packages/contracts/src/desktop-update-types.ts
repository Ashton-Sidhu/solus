/**
 * The desktop app's update status as the renderer sees it. The Electron main
 * process owns it: it runs the checks, drives the download, and holds the
 * auto-download setting. The renderer mirrors the status and issues commands.
 * Hosts never see any of it. Vocabulary: `docs/plans/desktop-updates.md`.
 */

/** One published desktop version. */
export interface DesktopUpdateRelease {
  version: string
  /** Markdown from the update feed manifest; null when the release shipped none. */
  releaseNotes: string | null
  releaseDate: string | null
}

export type DesktopUpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'up-to-date'; checkedAt: number }
  | { kind: 'available'; release: DesktopUpdateRelease }
  | { kind: 'downloading'; release: DesktopUpdateRelease; percent: number }
  /** Downloaded and on disk. Sticky: only a restart leaves it. */
  | { kind: 'ready'; release: DesktopUpdateRelease }
  | { kind: 'error'; message: string; release: DesktopUpdateRelease | null }

export interface DesktopUpdateStatus {
  /** The version that is running now. */
  currentVersion: string
  /** Download an update as soon as a check finds one. */
  autoDownload: boolean
  state: DesktopUpdateState
}

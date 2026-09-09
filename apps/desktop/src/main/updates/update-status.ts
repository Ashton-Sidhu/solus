import type { DesktopUpdateRelease, DesktopUpdateState } from '@solus/contracts/desktop-update-types'

/**
 * The update state machine, kept pure so the transitions can be tested without
 * Electron. `docs/plans/desktop-updates.md` draws the graph these encode.
 */
export type UpdateEvent =
  | { type: 'checking' }
  | { type: 'not-available'; at: number }
  | { type: 'available'; release: DesktopUpdateRelease }
  | { type: 'download-started' }
  | { type: 'progress'; percent: number }
  | { type: 'downloaded'; release: DesktopUpdateRelease }
  | { type: 'error'; message: string }

function releaseOf(state: DesktopUpdateState): DesktopUpdateRelease | null {
  return 'release' in state ? state.release : null
}

export function reduceUpdateState(state: DesktopUpdateState, event: UpdateEvent): DesktopUpdateState {
  // The update is on disk. Nothing but a restart moves the app past it, so a
  // later check, progress tick, or error never demotes the state.
  if (state.kind === 'ready') return state

  switch (event.type) {
    case 'checking':
      return { kind: 'checking' }
    case 'not-available':
      return { kind: 'up-to-date', checkedAt: event.at }
    case 'available':
      return { kind: 'available', release: event.release }
    case 'download-started': {
      const release = releaseOf(state)
      return release ? { kind: 'downloading', release, percent: 0 } : state
    }
    case 'progress': {
      const release = releaseOf(state)
      return release ? { kind: 'downloading', release, percent: event.percent } : state
    }
    case 'downloaded':
      return { kind: 'ready', release: event.release }
    case 'error':
      return { kind: 'error', message: event.message, release: releaseOf(state) }
  }
}

/** The subset of electron-updater's `UpdateInfo` the renderer is allowed to see. */
export function releaseFromUpdateInfo(info: {
  version: string
  releaseNotes?: string | Array<{ version: string; note: string | null }> | null
  releaseDate?: string
}): DesktopUpdateRelease {
  const notes = Array.isArray(info.releaseNotes)
    ? info.releaseNotes.map((entry) => entry.note ?? '').filter(Boolean).join('\n\n')
    : info.releaseNotes ?? ''
  return {
    version: info.version,
    releaseNotes: notes.trim() ? notes : null,
    releaseDate: info.releaseDate ?? null,
  }
}

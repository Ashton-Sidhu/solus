import type { DesktopUpdateState } from '@solus/contracts/desktop-update-types'

/** What the About section says for one update state. */
export function updateStatusLine(state: DesktopUpdateState): string {
  switch (state.kind) {
    case 'idle':
      return 'Not checked yet.'
    case 'checking':
      return 'Checking for updates…'
    case 'up-to-date':
      return `Up to date. Last checked ${formatCheckedAt(state.checkedAt)}.`
    case 'available':
      return `Solus ${state.release.version} is available.`
    case 'downloading':
      return `Downloading Solus ${state.release.version}… ${Math.round(state.percent)}%`
    case 'ready':
      return `Solus ${state.release.version} is ready. Restart to finish the update.`
    case 'error':
      return state.message
  }
}

export type UpdateCommand = 'check' | 'download' | 'restart'

/** The one command that moves the state forward, or null while it is moving on its own. */
export function updateCommandFor(state: DesktopUpdateState): { command: UpdateCommand; label: string } | null {
  switch (state.kind) {
    case 'idle':
    case 'up-to-date':
      return { command: 'check', label: 'Check for updates' }
    case 'error':
      return { command: 'check', label: 'Try again' }
    case 'available':
      return { command: 'download', label: 'Download' }
    case 'ready':
      return { command: 'restart', label: 'Restart to update' }
    case 'checking':
    case 'downloading':
      return null
  }
}

export function formatCheckedAt(checkedAt: number, now = Date.now()): string {
  const minutes = Math.round((now - checkedAt) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return new Date(checkedAt).toLocaleDateString()
}

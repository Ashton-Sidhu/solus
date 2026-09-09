import type { UpdateCheckState } from '@solus/contracts/host-update-types'
import { compareVersions } from '@solus/contracts/version'

export type CheckEvent =
  | { kind: 'check' }
  | { kind: 'idle'; reason: string }
  | { kind: 'result'; current: string; latest: string; now: number }
  | { kind: 'error'; message: string; latestVersion: string | null; now: number }

export function reduceCheckState(state: UpdateCheckState, event: CheckEvent): UpdateCheckState {
  switch (event.kind) {
    case 'check': return state.kind === 'checking' ? state : { kind: 'checking' }
    case 'idle': return { kind: 'idle', reason: event.reason }
    case 'result': return compareVersions(event.current, event.latest) < 0
      ? { kind: 'available', latestVersion: event.latest, checkedAt: event.now }
      : { kind: 'up-to-date', checkedAt: event.now }
    case 'error': return { kind: 'error', message: event.message, latestVersion: event.latestVersion, checkedAt: event.now }
  }
}

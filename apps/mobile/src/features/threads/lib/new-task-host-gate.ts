import type { HostReadinessState } from '@solus/client-core/host-readiness'

/**
 * Whether a new task can be written now (docs/plans/host-readiness.md "Draft
 * gate"). A task no host can run is not a composer: the sheet asks the person
 * to connect a host instead, and keeps the draft's text until one answers.
 */
export type NewTaskHostGate = 'compose' | 'connect'

/**
 * One ready host is enough to compose. A host that is not away (inside the
 * grace) keeps the composer, so a short drop does not take it away. No saved
 * host, or every host away, asks for a host. Once the connect page shows, only
 * a ready host brings the composer back: a retried refused host gets a new
 * link that is not away until it fails again, and that dial must not show the
 * composer.
 */
export function newTaskHostGate(states: readonly Pick<HostReadinessState, 'readiness' | 'away'>[], previous: NewTaskHostGate): NewTaskHostGate {
  if (states.some((state) => state.readiness === 'ready')) return 'compose'
  if (previous === 'connect') return 'connect'
  return states.some((state) => !state.away) ? 'compose' : 'connect'
}

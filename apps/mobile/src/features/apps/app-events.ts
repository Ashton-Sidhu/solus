import type { AppActivityKind } from '@solus/contracts/apps'

/**
 * What a host says of one app, as the app's screens hear it
 * (docs/plans/apps.md §5): `apps.changed`, `apps.dataChanged`, and
 * `apps.activity`. A Manage screen reads again only what an event changes.
 */
export type AppEvent =
  | { readonly kind: 'changed' }
  | { readonly kind: 'deleted' }
  | { readonly kind: 'data-changed' }
  | { readonly kind: 'activity'; readonly kinds: readonly AppActivityKind[] }

/**
 * Each read of the Manage screens, with the kinds of activity that change
 * what it shows. A read with no kind changes only when the app changed.
 */
export const APP_READ_ACTIVITY = {
  /** The summary counts the calls of 24 hours and names a failed workflow; the runner counts what is in progress. */
  state: ['calls', 'runs'],
  metrics: ['calls'],
  calls: ['calls'],
  call: ['calls'],
  /** A run of a schedule is a call. */
  schedules: ['calls'],
  runs: ['runs'],
  run: ['runs'],
  signals: ['signals'],
  occurrences: ['signals'],
  files: ['files'],
  modelCall: ['models'],
  deployment: ['deployment'],
  versions: [],
  revisions: [],
  buildLog: [],
  webhooks: [],
  sessions: [],
} as const satisfies Record<string, readonly AppActivityKind[]>

export type AppReadName = keyof typeof APP_READ_ACTIVITY

/** Whether one event of the app changes what a read shows. A deploy, a stop, or a start can change every read. */
export function eventChangesRead(event: AppEvent, read: AppReadName): boolean {
  if (event.kind === 'changed') return true
  if (event.kind !== 'activity') return false
  const kinds: readonly AppActivityKind[] = APP_READ_ACTIVITY[read]
  return event.kinds.some((kind) => kinds.includes(kind))
}

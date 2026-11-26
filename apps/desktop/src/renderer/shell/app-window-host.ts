import type { AnswerState } from '@solus/client-core/host-catalog'

/** The host of an app window's app, as this client knows it now. */
export type AppWindowHost =
  /** This client has a connection id for the host. */
  | { kind: 'known'; serverId: string }
  /** The person's host list is not read yet: the host can still be on it. */
  | { kind: 'finding' }
  /** The list was read, or its read failed, and it does not name the host. */
  | { kind: 'unknown' }

export const APP_WINDOW_HOST_UNKNOWN_TEXT = 'This computer has no connection to the host of this app.'

/**
 * An app link names its host by installation id, which holds on every launch;
 * a connection id names a host only on this client. This computer's own host
 * is known at once. Another host is known when the person's host list names it.
 */
export function appWindowHost(
  knownHosts: ReadonlyArray<{ id: string; installationId?: string }>,
  listState: AnswerState,
  installationId: string,
): AppWindowHost {
  const host = knownHosts.find((candidate) => candidate.installationId === installationId)
  if (host) return { kind: 'known', serverId: host.id }
  return listState === 'loading' ? { kind: 'finding' } : { kind: 'unknown' }
}

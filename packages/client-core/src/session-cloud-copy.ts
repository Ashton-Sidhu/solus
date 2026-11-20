import type { SolusAPI } from '@solus/contracts/host-api'
import { sessionTurnDiffSchema, type SessionTurnDiff } from '@solus/contracts/session-repositories'
import { workspaceErrorSchema } from '@solus/contracts/solus-api/schemas'

/**
 * The read-only copy of a session from Solus Cloud, for a client with no host
 * online that holds the session (docs/plans/portable-sessions-cloud.md,
 * "Phase 5A as implemented (API reader)" and "Phase 5B (mobile) as
 * implemented"). The Solus API reads the session repository at the head it
 * accepted: `loadSessionPage` answers one whole turn for each page, newest
 * first, and `sessionTurnDiff` answers the patch of one turn. Rows hold no
 * tool result bodies (design D8). Desktop, web, and mobile use the same rule.
 */

/** What a client read of the copy: nothing yet, a read in flight, the rows, or a failure. */
export type SessionCloudCopyRead =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'error'; message: string }

/** Why the copy that shows can be behind: a host that holds the session is
 *  connected now, or the cloud's head moved after the read. */
export type SessionCloudCopyStale =
  | { kind: 'host-online'; serverId: string }
  | { kind: 'head-changed' }

/**
 * What the conversation shows in place of a host's history.
 *
 * - `not-signed-in`: the copy belongs to the account; signed out there is none.
 * - `sync-off`: the run host keeps the session off Solus Cloud.
 * - `not-in-cloud`: the cloud does not list the session, for a reason this client cannot tell.
 * - `empty`: the cloud lists the session, but no turn commit reached it yet.
 * - `ready`: the rows show, read-only. `unavailableTurns` counts the read
 *   turns that have no rows in the cloud (older hosts, or a cut page).
 */
export type SessionCloudCopyState =
  | { kind: 'not-signed-in' }
  | { kind: 'sync-off' }
  | { kind: 'not-in-cloud' }
  | { kind: 'empty' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; unavailableTurns: number; stale: SessionCloudCopyStale | null }

export interface SessionCloudCopyInput {
  /** A prompt started the session; a new session has nothing to read. */
  hasStarted: boolean
  /** A host gave the rows that show: its history, or a transcript carried from another host. */
  showsHostConversation: boolean
  /** The run host is past its grace and not back. */
  isRunHostAway: boolean
  /** The run host's history read failed. */
  hasLoadFailed: boolean
  /** The run host answered that it has no copy of the session. */
  awaitsHostCopy: boolean
  isSignedIn: boolean
  /** `none`: no Solus API connection; `loading`: its first list read has not answered. */
  cloudList: 'none' | 'loading' | 'listed'
  /** What the cloud's list says of the session; null when it does not list it. */
  cloud: { head: string | null; syncedTurn: number } | null
  /** The run host's `sessionCloudSync` setting as this client last read it; null when unknown. */
  isCloudSyncOn: boolean | null
  read: SessionCloudCopyRead
  /** The head the rows that show were read at; null before a read. */
  readHead: string | null
  /** Read turns that have no rows in the cloud. */
  unavailableTurns: number
  /** A connected host, not the run host, that holds the session. */
  liveServerId: string | null
}

/** The copy's state; null when a host shows the conversation or the run host can still answer. */
export function sessionCloudCopyState(input: SessionCloudCopyInput): SessionCloudCopyState | null {
  if (!input.hasStarted || input.showsHostConversation) return null
  if (!input.isRunHostAway && !input.hasLoadFailed && !input.awaitsHostCopy) return null
  if (!input.isSignedIn) return { kind: 'not-signed-in' }
  if (input.read.kind === 'ready') {
    const stale: SessionCloudCopyStale | null = input.liveServerId
      ? { kind: 'host-online', serverId: input.liveServerId }
      : input.cloud?.head && input.cloud.head !== input.readHead ? { kind: 'head-changed' } : null
    return { kind: 'ready', unavailableTurns: input.unavailableTurns, stale }
  }
  if (!input.cloud) {
    if (input.cloudList === 'loading') return { kind: 'loading' }
    return input.isCloudSyncOn === false ? { kind: 'sync-off' } : { kind: 'not-in-cloud' }
  }
  if (!input.cloud.head || input.cloud.syncedTurn <= 0) return { kind: 'empty' }
  if (input.read.kind === 'error') return { kind: 'error', message: input.read.message }
  return { kind: 'loading' }
}

/** Whether the client starts a read of the copy now: it applies, the cloud has a head, and nothing read it yet. */
export function shouldReadSessionCloudCopy(input: SessionCloudCopyInput): boolean {
  return input.read.kind === 'idle' && sessionCloudCopyState(input)?.kind === 'loading' && !!input.cloud?.head
}

/** The words of a state that takes the conversation's place; null for `loading` and `ready`. */
export function sessionCloudCopyPlaceholder(state: SessionCloudCopyState, hostLabel: string): { title: string; detail: string } | null {
  switch (state.kind) {
    case 'not-signed-in': return { title: `${hostLabel} is offline`, detail: 'Sign in to Solus Cloud to read this session while no host that has it is online.' }
    case 'sync-off': return { title: 'This session is not in Solus Cloud', detail: `Cloud sync is off on ${hostLabel}. The conversation shows here when ${hostLabel} is back.` }
    case 'not-in-cloud': return { title: 'This session is not in Solus Cloud', detail: `The conversation shows here when ${hostLabel} is back.` }
    case 'empty': return { title: 'No turns in Solus Cloud yet', detail: 'The first turn shows here after a host sends it to Solus Cloud. Select a host in Run on, or send a prompt.' }
    case 'error': return { title: 'Solus Cloud could not be read', detail: state.message }
    case 'loading':
    case 'ready': return null
  }
}

/** The note beside a copy that shows. `hostLabel` names the host of a stale state. */
export function sessionCloudCopyNote(state: Extract<SessionCloudCopyState, { kind: 'ready' }>, hostLabel: (serverId: string) => string): string {
  if (state.stale?.kind === 'host-online') return `${hostLabel(state.stale.serverId)} is online. This copy can be behind.`
  if (state.stale?.kind === 'head-changed') return 'Newer turns are in Solus Cloud.'
  const missing = state.unavailableTurns === 1 ? ' 1 turn is not in Solus Cloud.' : state.unavailableTurns > 1 ? ` ${state.unavailableTurns} turns are not in Solus Cloud.` : ''
  return `Read-only copy from Solus Cloud. Tool output is not included.${missing}`
}

/** The path of one turn's diff on the Solus API (`sessionTurnDiff`), under `/v1`. */
export function sessionTurnDiffPath(sessionId: string, turnIndex: number): string {
  return `/sessions/${encodeURIComponent(sessionId)}/turns/${turnIndex}/diff`
}

/**
 * The diff of one turn, over the client's socket to the Solus API. The
 * contract's request client fills only the first path parameter, so this names
 * the path itself. A Solus API with no such route answers `not-available`.
 */
export async function readSessionTurnDiff(api: Pick<SolusAPI, 'solusApiRequest'>, sessionId: string, turnIndex: number): Promise<SessionTurnDiff> {
  const response = await api.solusApiRequest({ method: 'GET', path: sessionTurnDiffPath(sessionId, turnIndex) })
  if (response.status === 404) return { status: 'not-available' }
  if (response.status < 200 || response.status > 299) throw new Error(errorMessage(response.body) ?? `Solus Cloud answered ${response.status}.`)
  return sessionTurnDiffSchema.parse(JSON.parse(response.body))
}

function errorMessage(body: string): string | null {
  try {
    const parsed = workspaceErrorSchema.safeParse(JSON.parse(body))
    return parsed.success ? parsed.data.error.message : null
  } catch { return null }
}

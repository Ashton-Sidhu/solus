import type { SessionSyncFailure } from '@solus/contracts/rpc'
import type { StatusCardState } from '@solus/contracts/types'

/** The host publishes one sync card for each session, with this id prefix. */
const SESSION_SYNC_CARD_PREFIX = 'session-sync-'

/** Whether a status card is the sync card of a portable session
 *  (docs/plans/portable-sessions.md §19, Part D), for `sessionId` when named. */
export function isSessionSyncCard(card: Pick<StatusCardState, 'id'>, sessionId?: string): boolean {
  return sessionId ? card.id === `${SESSION_SYNC_CARD_PREFIX}${sessionId}` : card.id.startsWith(SESSION_SYNC_CARD_PREFIX)
}

/** The names a sync card speaks in. The host knows only ids; the client knows labels. */
export interface SessionSyncCardNames {
  /** The host that has the newest turn, the one the session comes from. */
  sourceHost: string
  /** The host the session syncs to, which runs the next turn. */
  runHost: string
  /** The agent of the session: "Claude" or "Codex". */
  provider: string
}

/** What a person can do about a failed sync. */
export type SessionSyncAction = 'connect-seat' | null

export interface SessionSyncFailureText {
  message: string
  action: SessionSyncAction
}

/** The label of each step, in the order the host runs them. */
export function sessionSyncStepLabel(stepId: string, names: SessionSyncCardNames): string | null {
  switch (stepId) {
    case 'fetch': return `Getting the session from ${names.sourceHost}`
    case 'preflight': return `Checking ${names.provider}`
    case 'checkout': return 'Preparing the code'
    case 'thread': return 'Restoring the conversation'
    case 'records': return 'Finishing'
    default: return null
  }
}

/** What a person can do about each reason a sync failed. */
export function sessionSyncFailureAction(reason: SessionSyncFailure): SessionSyncAction {
  if (reason === 'seat-required') return 'connect-seat'
  return null
}

/** A plain text for each reason a sync failed, and the action that fits it. */
export function sessionSyncFailureText(reason: SessionSyncFailure, names: SessionSyncCardNames): SessionSyncFailureText {
  const { sourceHost, runHost, provider } = names
  const messages = {
    'not-signed-in': { message: `The newer turns are in Solus Cloud. Sign in on ${runHost}.`, action: null },
    'commit-failed': { message: `The last turn on ${sourceHost} was not saved. Try again.`, action: null },
    'provider-unavailable': { message: `${provider} is not installed on ${runHost}. Install it there.`, action: null },
    'seat-required': { message: `Connect ${provider} on ${runHost} to continue this session there.`, action: 'connect-seat' },
    'model-unavailable': { message: `${runHost} does not offer the model of this session. Choose another model.`, action: null },
    'provider-too-old': { message: `${provider} on ${runHost} is older than the version that ran this session. Update it.`, action: null },
    'source-offline': { message: `${sourceHost} is offline. It has the newest turn of this session. Turn it on.`, action: null },
    'no-repository': { message: `${sourceHost} has no saved copy of this session yet. Continue on ${sourceHost}.`, action: null },
    'no-project-checkout': { message: `${runHost} has no copy of this project, and the project has no remote to clone.`, action: null },
    diverged: { message: `${runHost} has other turns of this session than ${sourceHost}. Continue on ${sourceHost}.`, action: null },
    'code-restore': { message: `The code of this session could not be restored on ${runHost}. Nothing there was changed.`, action: null },
    'thread-conflict': { message: `${runHost} has a different copy of this conversation. Nothing there was changed.`, action: null },
    interrupted: { message: 'The sync was stopped. Send again to continue.', action: null },
    failed: { message: `The session could not sync to ${runHost}.`, action: null },
  } satisfies Record<SessionSyncFailure, SessionSyncFailureText>
  return messages[reason]
}

/**
 * The sync card as the client shows it: each step with its label, the title
 * named for the hosts, and a failed step that says why and what to do. Any
 * other card returns unchanged.
 */
export function sessionSyncCardView(card: StatusCardState, names: SessionSyncCardNames): StatusCardState {
  if (!isSessionSyncCard(card)) return card
  const failure = card.syncFailureReason ? sessionSyncFailureText(card.syncFailureReason, names) : null
  const title = card.status === 'error'
    ? `Could not sync to ${names.runHost}`
    : card.status === 'done' ? 'Session ready' : `Syncing from ${names.sourceHost}`
  const shown: StatusCardState = {
    ...card,
    title,
    steps: card.steps.map((step) => {
      const labelled = { ...step, label: sessionSyncStepLabel(step.id, names) ?? step.label }
      if (step.status === 'error' && failure) labelled.detail = failure.message
      return labelled
    }),
  }
  // The host's own words stay readable as the card's output.
  const hostDetail = card.steps.find((step) => step.status === 'error')?.detail
  if (failure && hostDetail && !card.output?.length) shown.output = [hostDetail]
  return shown
}

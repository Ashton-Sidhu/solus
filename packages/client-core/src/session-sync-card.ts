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
export type SessionSyncAction = 'connect-seat' | 'choose-host' | null

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
  if (reason === 'interrupted') return null
  return 'choose-host'
}

/** A plain text for each reason a sync failed, and the action that fits it. */
export function sessionSyncFailureText(reason: SessionSyncFailure, names: SessionSyncCardNames): SessionSyncFailureText {
  const { sourceHost, runHost, provider } = names
  switch (reason) {
    case 'provider-unavailable':
      return { message: `${provider} is not installed on ${runHost}. Install it there, or choose another host.`, action: 'choose-host' }
    case 'seat-required':
      return { message: `Connect ${provider} on ${runHost} to continue this session there.`, action: 'connect-seat' }
    case 'model-unavailable':
      return { message: `${runHost} does not offer the model of this session. Choose another model or another host.`, action: 'choose-host' }
    case 'provider-too-old':
      return { message: `${provider} on ${runHost} is older than the version that ran this session. Update it, or choose another host.`, action: 'choose-host' }
    case 'source-offline':
      return { message: `${sourceHost} is offline. It has the newest turn of this session. Turn it on, or choose another host.`, action: 'choose-host' }
    case 'no-repository':
      return { message: `${sourceHost} has no saved copy of this session yet. Continue on ${sourceHost}.`, action: 'choose-host' }
    case 'no-project-checkout':
      return { message: `${runHost} has no copy of this project, and the project has no remote to clone. Choose another host.`, action: 'choose-host' }
    case 'diverged':
      return { message: `${runHost} has other turns of this session than ${sourceHost}. Continue on ${sourceHost}.`, action: 'choose-host' }
    case 'code-restore':
      return { message: `The code of this session could not be restored on ${runHost}. Nothing there was changed.`, action: 'choose-host' }
    case 'thread-conflict':
      return { message: `${runHost} has a different copy of this conversation. Nothing there was changed.`, action: 'choose-host' }
    case 'interrupted':
      return { message: 'The sync was stopped. Send again to continue.', action: null }
    case 'failed':
      return { message: `The session could not sync to ${runHost}.`, action: 'choose-host' }
  }
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

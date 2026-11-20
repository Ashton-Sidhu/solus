import type { SessionCloudReadView, SessionTurnDiffView } from './session-cloud-read'

// The words of a read-only conversation (`session-cloud-read.ts`). Apart from
// the rules, so a client's first screen does not load them.

export interface SessionCloudReadText {
  message: string
  /** A second line, or null. */
  detail: string | null
  /** The one action the state offers, or null. */
  action: 'show-newer' | 'show-live' | 'retry' | null
}

/** The words of each state. `hostLabel` names the run host. */
export function sessionCloudReadText(view: SessionCloudReadView, hostLabel: string): SessionCloudReadText {
  switch (view.kind) {
    case 'not-signed-in': return { message: `${hostLabel} is offline.`, detail: 'Sign in to read this session from Solus Cloud.', action: null }
    case 'sync-off': return { message: 'Solus Cloud has no copy of this session.', detail: 'Cloud sync was off on the machine that ran it. Turn that machine on, or choose a machine in Run on.', action: null }
    case 'empty': return view.reason === 'no-turns'
      ? { message: 'No turn of this session is in Solus Cloud yet.', detail: 'Choose a machine that has the session in Run on.', action: null }
      : { message: 'The turns in Solus Cloud have no saved conversation.', detail: 'Choose a machine that has the session in Run on to read them.', action: null }
    case 'loading': return { message: 'Reading the conversation from Solus Cloud', detail: null, action: null }
    case 'error': return { message: view.message, detail: null, action: 'retry' }
    case 'ready': return {
      message: 'Read only, from Solus Cloud. Choose a machine in Run on and send to continue.',
      detail: view.unavailableTurnCount > 0
        ? `Tool output is not in the cloud copy. ${view.unavailableTurnCount === 1 ? 'One older turn is' : `${view.unavailableTurnCount} older turns are`} not in it either.`
        : 'Tool output is not in the cloud copy.',
      action: null,
    }
    case 'stale': return view.reason === 'head-changed'
      ? { message: 'Newer turns are in Solus Cloud.', detail: null, action: 'show-newer' }
      : { message: `${hostLabel} has this session now.`, detail: null, action: 'show-live' }
  }
}

/** The words of a turn diff that is not a patch to draw. */
export function sessionTurnDiffText(view: SessionTurnDiffView): string | null {
  switch (view.status) {
    case 'loading': return 'Reading the diff from Solus Cloud'
    case 'error': return 'The diff could not be read from Solus Cloud.'
    case 'no-change': return 'This turn changed no files.'
    case 'not-available': return 'Solus Cloud has no diff of this turn.'
    case 'too-large': return `This turn changed ${view.filesChanged === 1 ? '1 file' : `${view.filesChanged} files`} (+${view.additions} −${view.deletions}). The diff is too large to show from Solus Cloud. Open the session on a machine to see it.`
    case 'available': return null
  }
}

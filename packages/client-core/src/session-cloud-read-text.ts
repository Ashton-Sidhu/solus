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

/** The words and available action for each cloud read state. */
export function sessionCloudReadText(view: SessionCloudReadView, hostLabel: string): SessionCloudReadText {
  switch (view.kind) {
    case 'not-signed-in': return { message: `${hostLabel} is offline.`, detail: 'Sign in to read this session from Solus Cloud.', action: null }
    case 'sync-off': return { message: 'Solus Cloud has no copy of this session.', detail: 'It is stored only on the machine that ran it.', action: null }
    case 'not-in-cloud': return { message: 'Solus Cloud has no copy of this session.', detail: 'The machine that ran it has cloud sync off, or has not sent it yet.', action: null }
    case 'loading': return { message: 'Reading the conversation from Solus Cloud', detail: null, action: null }
    case 'error': return { message: view.message, detail: null, action: 'retry' }
    case 'ready': return { message: 'Read only, from Solus Cloud.', detail: 'Tool output is not available in Solus Cloud.', action: null }
    case 'stale': return view.reason === 'newer-rows'
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

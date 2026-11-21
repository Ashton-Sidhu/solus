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

/**
 * The words of each state. `hostLabel` names the run host. `canContinue` is
 * false when the reader cannot pick a machine and send: the words then name
 * no Run on.
 */
export function sessionCloudReadText(view: SessionCloudReadView, hostLabel: string, canContinue = true): SessionCloudReadText {
  const text = continuableText(view, hostLabel)
  if (canContinue) return text
  switch (view.kind) {
    case 'sync-off': return { ...text, detail: 'Cloud sync was off on the machine that ran it.' }
    case 'not-in-cloud': return { ...text, detail: 'The machine that ran it has cloud sync off, or has not sent it yet.' }
    case 'ready': return { ...text, message: 'Read only, from Solus Cloud.' }
    default: return text
  }
}

function continuableText(view: SessionCloudReadView, hostLabel: string): SessionCloudReadText {
  switch (view.kind) {
    case 'not-signed-in': return { message: `${hostLabel} is offline.`, detail: 'Sign in to read this session from Solus Cloud.', action: null }
    case 'sync-off': return { message: 'Solus Cloud has no copy of this session.', detail: 'Cloud sync was off on the machine that ran it. Turn that machine on, or choose a machine in Run on.', action: null }
    case 'not-in-cloud': return { message: 'Solus Cloud has no copy of this session.', detail: 'The machine that ran it has cloud sync off, or has not sent it yet. Turn that machine on, or choose a machine that has the session in Run on.', action: null }
    case 'loading': return { message: 'Reading the conversation from Solus Cloud', detail: null, action: null }
    case 'error': return { message: view.message, detail: null, action: 'retry' }
    case 'ready': return { message: 'Read only, from Solus Cloud. Choose a machine in Run on and send to continue.', detail: 'Tool output is not available in Solus Cloud.', action: null }
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

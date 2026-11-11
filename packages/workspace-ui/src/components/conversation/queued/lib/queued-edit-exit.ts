// Adapted from T3 Code apps/web/src/components/chat/queuedMessageEdit.ts
// (`recoverQueuedMessageEdit`, pingdotgg/t3code#29601) (MIT, see UPSTREAM.md).

/** What happens to an open queue edit when its entry leaves the queue:
 * `kept` puts the text back in the composer, `discarded` drops it with a
 * notice, and `clean` closes an unchanged edit with no notice. */
export type QueuedEditExit = 'kept' | 'discarded' | 'clean'

export function queuedEditExit(input: {
  /** The text differs from the entry's, or an attachment was added or removed. */
  readonly changed: boolean
  readonly text: string
  readonly composerDraftEmpty: boolean
}): QueuedEditExit {
  if (!input.changed) return 'clean'
  // An attachment-only edit has no text to put back, so it can only be discarded.
  return input.text.trim() && input.composerDraftEmpty ? 'kept' : 'discarded'
}

export const QUEUED_EDIT_EXIT_NOTICE = {
  kept: 'That message already started. Your edit is back in the composer.',
  discarded: 'That message already started, so the edit was discarded.',
} as const

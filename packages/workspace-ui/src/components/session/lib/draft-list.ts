import type { Prompt } from '@solus/contracts/types'

/**
 * A prompt that was written but never sent, as the sidebar shows it. A draft has
 * no session, no tab and no task record, so a row here reports the two things it
 * does know: what it says, and where it would run.
 */
export interface DraftRow {
  draftId: string
  title: string
  projectKey: string
  projectLabel: string
  serverId: string
  /** True when the prompt carries files the title cannot show. */
  hasAttachments: boolean
}

/** A title long enough to fill any sidebar width. The row truncates in CSS; the
 *  cap only keeps a pasted essay out of the DOM and out of the tooltip. */
const TITLE_LIMIT = 160

/**
 * What a draft is called. Nothing names it, so its first written line does — the
 * same thing a person would read out to say which draft they mean. A draft with
 * only files attached has no line to use and says so plainly.
 */
export function draftTitle(prompt: Prompt): string {
  // Only the head of the text is read. This runs on every keystroke in the
  // composer, and splitting a pasted document to find its first line would make
  // the sidebar pay for the whole paste each time a letter lands.
  const start = prompt.text.search(/\S/)
  if (start < 0) {
    const count = prompt.attachments.length
    return count === 1 ? '1 attachment' : `${count} attachments`
  }
  const lineEnd = prompt.text.indexOf('\n', start)
  const head = prompt.text.slice(start, lineEnd < 0 ? undefined : lineEnd)
  const collapsed = head.slice(0, TITLE_LIMIT + 1).replace(/\s+/g, ' ').trimEnd()
  return collapsed.length > TITLE_LIMIT ? `${collapsed.slice(0, TITLE_LIMIT).trimEnd()}…` : collapsed
}

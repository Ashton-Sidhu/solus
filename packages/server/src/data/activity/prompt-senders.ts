import { createHash } from 'node:crypto'
import type { Activity } from '@solus/contracts/activity'
import { startsHistoryTurn, type SessionLoadMessage } from '@solus/contracts/session-history'
import type { PromptSender } from '@solus/contracts/types'
import type { RecordScope } from '../../admission/principal'
import { activityFor, appendActivity, newActivity } from './activity'

/**
 * Who sent a prompt that no person typed (docs/plans/prompt-sender.md). The
 * provider's transcript keeps only the prompt's text, so the host keeps the
 * sender as a `prompt_sent` activity, whose `by` is the sender, and a history
 * read folds it back onto the user row the prompt became. The activity is
 * never drawn as a row of its own.
 */

/** How far apart the record and the provider's user row may be. The host
 *  records the prompt as the run launches; the provider writes its row a little
 *  later, and Codex dates a steered prompt from the start of its turn. */
const MATCH_WINDOW_MS = 10 * 60 * 1000

/** The key a prompt and its user row share: the text, without the space around it. */
export function promptHash(text: string): string {
  return createHash('sha256').update(text.trim()).digest('base64url')
}

/** Keep the sender of a prompt the host is about to send into `sessionId`. */
export async function recordPromptSender(organizationId: string, sessionId: string, sender: PromptSender, text: string): Promise<void> {
  await appendActivity(organizationId, newActivity({ kind: 'session', id: sessionId }, sender, { kind: 'prompt_sent', promptHash: promptHash(text) }))
}

/**
 * Put each recorded sender on the user row its prompt became: a row with the
 * same text, the one nearest in time. A record matches one row at most, and a
 * row whose text no record names stays a person's prompt.
 */
export function stampPromptSenders(messages: SessionLoadMessage[], records: Activity[]): void {
  const prompts = messages.filter(startsHistoryTurn)
  const hashes = new Map(prompts.map((message) => [message, promptHash(message.content)]))
  for (const record of records) {
    if (record.kind !== 'prompt_sent' || (record.by.kind !== 'agent' && record.by.kind !== 'automation')) continue
    let nearest: SessionLoadMessage | null = null
    for (const message of prompts) {
      const distance = Math.abs(message.timestamp - record.at)
      if (message.sender || hashes.get(message) !== record.promptHash || distance > MATCH_WINDOW_MS) continue
      if (!nearest || distance < Math.abs(nearest.timestamp - record.at)) nearest = message
    }
    if (nearest) nearest.sender = record.by
  }
}

/** Stamp the senders the host recorded for `sessionId` onto its history rows. */
export async function withPromptSenders(scope: RecordScope, sessionId: string, messages: SessionLoadMessage[]): Promise<SessionLoadMessage[]> {
  const prompts = messages.filter(startsHistoryTurn)
  if (!prompts.length) return messages
  const window = {
    from: Math.min(...prompts.map((message) => message.timestamp)) - MATCH_WINDOW_MS,
    until: Math.max(...prompts.map((message) => message.timestamp)) + MATCH_WINDOW_MS,
  }
  const records = await activityFor(scope, { kind: 'session', id: sessionId }, { window, kind: 'prompt_sent' })
  if (records.length) stampPromptSenders(messages, records)
  return messages
}

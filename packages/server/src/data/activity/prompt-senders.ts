import { createHash } from 'node:crypto'
import type { Activity } from '@solus/contracts/activity'
import { stripAttachedFileLines } from '@solus/contracts/injected-context'
import { startsHistoryTurn, type SessionLoadMessage } from '@solus/contracts/session-history'
import type { PromptSender } from '@solus/contracts/types'
import type { Attribution } from '@solus/contracts/user'
import type { RecordScope } from '../../admission/principal'
import { activityFor, appendActivity, newActivity } from './activity'

/**
 * Who sent a prompt (docs/plans/prompt-sender.md). The provider's transcript
 * keeps only the prompt's text, so the host keeps who sent it as a `prompt_sent`
 * activity, whose `by` is that agent, automation, or person, and a history read
 * folds it back onto the user row the prompt became: an agent or an automation
 * as the row's `sender`, a person as its `author`. The activity is never drawn
 * as a row of its own.
 */

/** Who a `prompt_sent` record names: the agent or the automation that sent the prompt, or the person who wrote it. */
export type RecordedPromptSender = PromptSender | Extract<Attribution, { kind: 'user' }>

/** How far apart the record and the provider's user row may be. The host
 *  records the prompt as the run launches; the provider writes its row a little
 *  later, and Codex dates a steered prompt from the start of its turn. */
const MATCH_WINDOW_MS = 10 * 60 * 1000

/** The key a prompt and its user row share: the text, without the space around it. */
export function promptHash(text: string): string {
  return createHash('sha256').update(text.trim()).digest('base64url')
}

/**
 * The keys a user row answers to: its text, and its text without the
 * attached-file lines. The host keeps the hash of what the sender wrote, and
 * the provider's row has the composer's file lines before it.
 */
function rowHashes(content: string): string[] {
  const typed = stripAttachedFileLines(content)
  return typed === content ? [promptHash(content)] : [promptHash(content), promptHash(typed)]
}

/** Keep the sender of a prompt the host is about to send into `sessionId`. */
export async function recordPromptSender(organizationId: string, sessionId: string, sender: RecordedPromptSender, text: string): Promise<void> {
  await appendActivity(organizationId, newActivity({ kind: 'session', id: sessionId }, sender, { kind: 'prompt_sent', promptHash: promptHash(text) }))
}

/**
 * Put each recorded sender on the user row its prompt became: a row with the
 * same text, the one nearest in time. A record matches one row at most, and a
 * row whose text no record names stays as the provider gave it.
 */
export function stampPromptSenders(messages: SessionLoadMessage[], records: Activity[]): void {
  const prompts = messages.filter(startsHistoryTurn)
  const hashes = new Map(prompts.map((message) => [message, rowHashes(message.content)]))
  for (const record of records) {
    const by = record.by
    if (record.kind !== 'prompt_sent' || (by.kind !== 'agent' && by.kind !== 'automation' && by.kind !== 'user')) continue
    let nearest: SessionLoadMessage | null = null
    for (const message of prompts) {
      const distance = Math.abs(message.timestamp - record.at)
      if (message.sender || message.author || !hashes.get(message)?.includes(record.promptHash) || distance > MATCH_WINDOW_MS) continue
      if (!nearest || distance < Math.abs(nearest.timestamp - record.at)) nearest = message
    }
    if (!nearest) continue
    if (by.kind === 'user') nearest.author = by.user
    else nearest.sender = by
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

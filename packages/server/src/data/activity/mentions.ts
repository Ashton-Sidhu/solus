import type { ActivitySubject } from '@solus/contracts/activity'
import { mentionedPeople } from '@solus/contracts/mentions'
import type { PlanComment } from '@solus/contracts/types'
import { parseUserKey, type Attribution } from '@solus/contracts/user'
import type { Db } from '../../db/database'
import { LOCAL_ORGANIZATION_ID } from '../../host/host-category'
import { appendActivity, newActivity } from './activity'

/**
 * A mention is recorded once, when it is first saved (plans/012 §5, plan 004
 * item 13): each person `text` mentions that `previous` did not. An edit that
 * keeps a mention records nothing. Only an organization record has members to
 * mention; the notifications hub reads these rows by the mentioned person.
 */
export async function recordNewMentions(
  db: Db,
  organizationId: string,
  subject: ActivitySubject,
  by: Attribution,
  previous: string,
  text: string,
  threadId?: string,
): Promise<void> {
  if (organizationId === LOCAL_ORGANIZATION_ID) return
  const before = new Set(mentionedPeople(previous).map((mention) => mention.userId))
  for (const mention of mentionedPeople(text)) {
    if (before.has(mention.userId)) continue
    const activity = newActivity(subject, by, threadId ? { kind: 'mentioned', userId: parseUserKey(mention.userId), threadId } : { kind: 'mentioned', userId: parseUserKey(mention.userId) })
    await appendActivity(organizationId, activity, db)
  }
}

/**
 * The mentions a change to a work's threads first saved: each thread and reply
 * compared with the same message before, by id. A new message is compared with
 * nothing. `by` saved the change, so the mention is theirs.
 */
export async function recordThreadMentions(
  db: Db,
  organizationId: string,
  subject: ActivitySubject,
  by: Attribution,
  before: readonly PlanComment[],
  after: readonly PlanComment[],
): Promise<void> {
  if (organizationId === LOCAL_ORGANIZATION_ID) return
  const previousText = new Map<string, string>()
  for (const thread of before) {
    previousText.set(thread.id, thread.comment)
    for (const reply of thread.replies ?? []) previousText.set(reply.id, reply.text)
  }
  for (const thread of after) {
    const messages = [{ id: thread.id, text: thread.comment }, ...(thread.replies ?? []).map((reply) => ({ id: reply.id, text: reply.text }))]
    for (const message of messages) {
      const previous = previousText.get(message.id) ?? ''
      if (previous === message.text) continue
      await recordNewMentions(db, organizationId, subject, by, previous, message.text, thread.id)
    }
  }
}

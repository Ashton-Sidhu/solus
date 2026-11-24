import { z } from 'zod'
import type { QueuedPromptSnapshot } from '@solus/contracts/types'
import type { SessionQueueMutation, SessionQueueSnapshot } from '@solus/contracts/session-queue'
import type { AgentTool, AgentToolResult } from './agent-tool'
import { findSession, getSessionController, refusalOf } from './session-tools'

/**
 * `queue_session`: an agent manages the messages queued in a session, as the
 * person does from the queue above the input bar. It acts for the person the
 * calling session works for, so the host's queue rules apply as they do to that
 * person: only a message's author steers it, and only a held message's author
 * resumes it. Sessions on this host only.
 */

/** The queue changes an agent sends. The deprecated provider switch needs a client's run input. */
export type AgentQueueMutation = Exclude<SessionQueueMutation, { kind: 'switch' }>

const ACTIONS = ['list', 'read', 'edit', 'cancel', 'move', 'steer', 'resume'] as const
const LIST_TEXT_CHARS = 200
const READ_TEXT_CHARS = 16_000

const DESCRIPTION =
  "Manage the messages queued in a session (default: this one). list gives each queue_id and revision. read: one message. edit: replace its text. cancel. move: before before_queue_id, or to the end. steer: into the turn in progress. resume: release held messages. edit, cancel, move, and steer need the revision from list."

const fields = {
  action: z.enum(ACTIONS),
  session_id: z.string().optional().describe('The session whose queue to manage. Defaults to this session.'),
  queue_id: z.string().min(1).optional().describe('The queued message, from list. Needed for read, edit, cancel, move, and steer.'),
  revision: z.number().int().min(0).optional().describe('The revision list gave for the message. Needed for edit, cancel, move, and steer.'),
  text: z.string().optional().describe('The new text, for edit.'),
  before_queue_id: z.string().min(1).optional().describe('For move: the message to put it before. Omit to move it to the end.'),
}
const inputSchema = z.object(fields)
type QueueInput = z.output<typeof inputSchema>

export async function manageSessionQueue(input: QueueInput, callerSessionId: string | undefined): Promise<AgentToolResult> {
  const controller = getSessionController()
  if (!controller?.sessionQueue || !controller.changeSessionQueue) return { ok: false, text: 'queue_session is unavailable on this host.' }
  if (!callerSessionId) return { ok: false, text: 'queue_session is unavailable before the calling session is initialized.' }
  const target = await queueTarget(input, callerSessionId)
  if ('error' in target) return { ok: false, text: target.error }
  const { sessionId, label } = target

  if (input.action === 'list') return { ok: true, text: formatQueue(controller.sessionQueue(sessionId), label) }
  if (input.action === 'read') {
    const entry = controller.sessionQueue(sessionId).entries.find((item) => item.queueId === input.queue_id)
    if (!entry) return { ok: false, text: `No queued message ${input.queue_id ?? '(no queue_id)'} in ${label}. Call list for the current queue.` }
    const cut = entry.text.length > READ_TEXT_CHARS
    return { ok: true, text: `${entryLine(entry)}\n\n${cut ? `${entry.text.slice(0, READ_TEXT_CHARS)}\n[cut at ${READ_TEXT_CHARS} of ${entry.text.length} characters]` : entry.text}` }
  }

  const mutation = mutationFor(input)
  if ('error' in mutation) return { ok: false, text: mutation.error }
  try {
    const queue = await controller.changeSessionQueue(callerSessionId, sessionId, mutation)
    return { ok: true, text: `${doneText(input.action)}\n${formatQueue(queue, label)}` }
  } catch (error) {
    return { ok: false, text: error instanceof Error ? error.message : String(error) }
  }
}

/** The session whose queue the call is about, once the turn's person may read or change that queue as a client could. */
async function queueTarget(input: QueueInput, callerSessionId: string): Promise<{ sessionId: string; label: string } | { error: string }> {
  const named = input.session_id?.trim()
  const sessionId = named && named !== callerSessionId ? (await findSession(named))?.sessionId : callerSessionId
  if (!sessionId) return { error: `Session ${named} not found on this host.` }
  const refused = await refusalOf([input.action === 'list' || input.action === 'read' ? 'sessionQueue' : 'sessionQueueChange'], sessionId)
  if (refused) return { error: refused }
  return { sessionId, label: sessionId === callerSessionId ? 'this session' : `session ${sessionId}` }
}

function mutationFor(input: QueueInput): AgentQueueMutation | { error: string } {
  if (input.action === 'resume') return { kind: 'resume' }
  if (!input.queue_id || input.revision === undefined) return { error: `${input.action} needs queue_id and revision from list.` }
  const target = { queueId: input.queue_id, revision: input.revision }
  switch (input.action) {
    case 'edit':
      return input.text?.trim() ? { kind: 'edit', ...target, text: input.text } : { error: 'edit needs a non-empty text.' }
    case 'cancel': return { kind: 'remove', ...target }
    case 'steer': return { kind: 'steer', ...target }
    case 'move': return { kind: 'move', ...target, beforeQueueId: input.before_queue_id ?? null }
    default: return { error: `Unknown action ${input.action}.` }
  }
}

function doneText(action: QueueInput['action']): string {
  switch (action) {
    case 'edit': return 'The message is changed.'
    case 'cancel': return 'The message is removed.'
    case 'move': return 'The message is moved.'
    case 'steer': return 'The message went into the turn in progress.'
    default: return 'The held messages are released.'
  }
}

function formatQueue(queue: SessionQueueSnapshot, label: string): string {
  if (!queue.entries.length) return `The queue of ${label} is empty.`
  const lines = queue.entries.map((entry, index) => {
    const text = entry.text.length > LIST_TEXT_CHARS ? `${entry.text.slice(0, LIST_TEXT_CHARS)}… (${entry.text.length} characters; read gives more)` : entry.text
    return `${index + 1}. ${entryLine(entry)}\n   ${text.replace(/\n/g, ' ')}`
  })
  return `The queue of ${label}, in send order${queue.held ? ' (held: resume releases it)' : ''}:\n${lines.join('\n')}`
}

/** What a queued message is and why it waits, in one line. */
function entryLine(entry: QueuedPromptSnapshot): string {
  const parts = [`queue_id=${entry.queueId}`, `revision=${entry.revision ?? 0}`]
  if (entry.kind === 'provider_switch') parts.push('provider switch')
  if (entry.reason === 'rate_limit') {
    parts.push(entry.releaseAt ? `held by a rate limit until ${new Date(entry.releaseAt * 1000).toISOString()}` : 'held by a rate limit with no known reset')
  }
  if (entry.held) parts.push(entry.error ? `held after an error: ${entry.error}` : 'held')
  if (entry.author) parts.push(`by ${entry.author.displayName}`)
  return parts.join(' · ')
}

export const queueSessionAgentTool: AgentTool<typeof fields> = {
  name: 'queue_session',
  description: DESCRIPTION,
  inputFields: fields,
  requiresApproval: false,
  // An unknown field must fail: dropped, a misspelled session id leaves the
  // caller's own queue as the target.
  strictInput: true,
  execute: async (args, context) => manageSessionQueue(inputSchema.parse(args), context.sessionId()),
}

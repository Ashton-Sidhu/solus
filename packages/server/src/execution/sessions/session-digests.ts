import { z } from 'zod'
import {
  DIGEST_SUBAGENTS,
  DIGEST_TOOL_BUCKET_MS,
  DIGEST_TURNS,
  digestLine,
  type DigestSubagent,
  type DigestTurn,
  type SessionDigest,
} from '@solus/contracts/session-digest'
import type { NormalizedEvent } from '@solus/contracts/types'
import { isSubagentTool } from '../../data/sessions/result-projection'
import type { TurnCheckpointed } from '../../git/turn-checkpoints'
import { createLogger } from '../../logger'

const log = createLogger('SessionDigests', 'session-digests.ts')

/** While a turn runs, a digest is written, and its readers told, at most this often. */
export const DIGEST_WRITE_INTERVAL_MS = 5_000

export interface SessionDigestsDeps {
  load(sessionId: string): Promise<SessionDigest | null>
  write(digest: SessionDigest): Promise<void>
  /** Tell the readers of the session, and of each session above it, to read its tree again. */
  announce(sessionId: string): void
  now?: () => number
}

/** When a change is written: at once, within DIGEST_WRITE_INTERVAL_MS, or with the next write. */
type When = 'now' | 'soon' | 'none'
type EventOf<T extends NormalizedEvent['type']> = Extract<NormalizedEvent, { type: T }>

interface LiveDigest {
  digest: SessionDigest
  /** The last thing said in the open turn; it becomes `lastReply` when the turn settles. */
  reply: string | null
  timer: ReturnType<typeof setTimeout> | null
}

/** The events a digest reads; every other event is passed by without a queue. */
const READ_EVENTS = new Set<NormalizedEvent['type']>([
  'user_message', 'tool_call', 'tool_call_update', 'tool_call_complete', 'tool_result',
  'subagent_report', 'assistant_message', 'turn_settled',
])

/**
 * The one writer of each session's digest on the host that runs it
 * (docs/plans/session-digests.md). It reads the session's broadcast events, as
 * every provider emits them in the normalized shape, and each turn's
 * checkpoint. A digest is written when a turn starts, at most once every
 * DIGEST_WRITE_INTERVAL_MS while it runs, when it settles, and after each
 * checkpoint; never for a streamed token. With no turn running it is written at
 * once. Between turns it is not held in memory: the next change reads the row.
 */
export class SessionDigests {
  private readonly live = new Map<string, LiveDigest>()
  /** One change at a time per session, in the order the events came. */
  private readonly queues = new Map<string, Promise<void>>()
  private readonly now: () => number

  constructor(private readonly deps: SessionDigestsDeps) {
    this.now = deps.now ?? Date.now
  }

  /** Read one broadcast session event. */
  observe(sessionId: string, event: NormalizedEvent): void {
    if (!READ_EVENTS.has(event.type)) return
    const at = this.now()
    this.enqueue(sessionId, (live) => apply(live, event, at))
  }

  /** A turn's checkpoint: what the session changed so far, and what this turn changed. */
  checkpointed({ sessionId, changes, turn }: TurnCheckpointed): void {
    this.enqueue(sessionId, (live) => {
      live.digest.changes = changes
      // The checkpoint is the turn's that started last before it was taken.
      const owner = live.digest.turns.findLast((candidate) => candidate.startedAt <= turn.endedAt)
      if (owner) owner.changes = { filesChanged: turn.filesChanged, additions: turn.additions, deletions: turn.deletions }
      return 'now'
    })
  }

  /** Wait for every queued change: for tests and a clean shutdown. */
  async settled(): Promise<void> {
    await Promise.all(this.queues.values())
  }

  private enqueue(sessionId: string, change: (live: LiveDigest) => When): void {
    const previous = this.queues.get(sessionId) ?? Promise.resolve()
    const next = previous.then(async () => {
      const live = await this.liveDigest(sessionId)
      const when = change(live)
      // Only a running turn has a burst of changes to wait out.
      if (when === 'now' || (when === 'soon' && !openTurn(live.digest))) await this.flush(sessionId, live)
      else if (when === 'soon') this.schedule(sessionId, live)
    }).catch((error) => {
      log.warn('session_digest_update_failed', { sessionId, error: error instanceof Error ? error.message : String(error) })
    })
    this.queues.set(sessionId, next)
    void next.then(() => {
      if (this.queues.get(sessionId) === next) this.queues.delete(sessionId)
    })
  }

  private async liveDigest(sessionId: string): Promise<LiveDigest> {
    const held = this.live.get(sessionId)
    if (held) return held
    const live: LiveDigest = { digest: await this.deps.load(sessionId) ?? emptyDigest(sessionId), reply: null, timer: null }
    this.live.set(sessionId, live)
    return live
  }

  private schedule(sessionId: string, live: LiveDigest): void {
    if (live.timer) return
    live.timer = setTimeout(() => {
      live.timer = null
      this.enqueue(sessionId, () => 'now')
    }, DIGEST_WRITE_INTERVAL_MS)
    live.timer.unref?.()
  }

  private async flush(sessionId: string, live: LiveDigest): Promise<void> {
    if (live.timer) {
      clearTimeout(live.timer)
      live.timer = null
    }
    live.digest.updatedAt = this.now()
    await this.deps.write(live.digest)
    this.deps.announce(sessionId)
    // Between turns the stored digest is the only copy.
    if (!openTurn(live.digest) && !live.digest.subagents.some((subagent) => subagent.status === 'running')) this.live.delete(sessionId)
  }
}

function apply(live: LiveDigest, event: NormalizedEvent, at: number): When {
  const turn = openTurn(live.digest)
  if (turn && event.type !== 'user_message' && event.type !== 'turn_settled') turn.endedAt = Math.max(turn.endedAt, at)
  switch (event.type) {
    case 'user_message': return turnStarted(live, event, at)
    case 'tool_call': return toolCalled(live, event, at)
    case 'tool_call_update':
    case 'tool_call_complete': return subagentInputStreamed(live, event)
    case 'tool_result': return toolAnswered(live, event, at)
    case 'subagent_report': return subagentReported(live, event, at)
    case 'assistant_message': return replied(live, event)
    case 'turn_settled': return turnSettled(live, event)
    default: return 'none'
  }
}

function turnStarted(live: LiveDigest, event: EventOf<'user_message'>, at: number): When {
  const { turns } = live.digest
  const previous = openTurn(live.digest)
  if (previous) previous.settled = true
  turns.push({ id: event.clientPromptId ?? crypto.randomUUID(), startedAt: at, endedAt: at, settled: false, prompt: digestLine(event.text), toolCalls: [], changes: null })
  if (turns.length > DIGEST_TURNS) turns.splice(0, turns.length - DIGEST_TURNS)
  live.reply = null
  return 'now'
}

/** A sub-agent's own calls are the sub-agent's, not the turn's. */
function toolCalled(live: LiveDigest, event: EventOf<'tool_call'>, at: number): When {
  if (event.parentToolUseId) return 'none'
  const turn = openTurn(live.digest)
  if (turn) countToolCall(turn, at)
  const isSubagent = isSubagentTool(event)
  if (isSubagent) {
    const { subagents } = live.digest
    subagents.push({ id: event.toolId, title: subagentTitle(event.toolInput), status: 'running', startedAt: at, endedAt: null, detail: '' })
    if (subagents.length > DIGEST_SUBAGENTS) subagents.splice(0, subagents.length - DIGEST_SUBAGENTS)
  }
  return turn || isSubagent ? 'soon' : 'none'
}

/** Claude streams a call's input after the call: the sub-agent's title is in it. */
function subagentInputStreamed(live: LiveDigest, event: EventOf<'tool_call_update' | 'tool_call_complete'>): When {
  const subagent = event.toolId ? subagentOf(live.digest, event.toolId) : undefined
  if (!subagent || !event.toolInput || event.parentToolUseId) return 'none'
  subagent.title = subagentTitle(event.toolInput)
  return 'soon'
}

/** A sub-agent started in the background answers its launch at once and reports later. */
function toolAnswered(live: LiveDigest, event: EventOf<'tool_result'>, at: number): When {
  const subagent = subagentOf(live.digest, event.toolUseId)
  if (!subagent || event.parentToolUseId || event.isAsyncLaunch) return 'none'
  endSubagent(subagent, event.isError ? 'failed' : 'completed', event.content, at)
  return 'soon'
}

function subagentReported(live: LiveDigest, event: EventOf<'subagent_report'>, at: number): When {
  const subagent = subagentOf(live.digest, event.toolUseId)
  if (!subagent) return 'none'
  endSubagent(subagent, event.isError ? 'failed' : 'completed', event.text, at)
  return 'soon'
}

function replied(live: LiveDigest, event: EventOf<'assistant_message'>): When {
  if (!event.parentToolUseId && event.text.trim()) live.reply = digestLine(event.text)
  return 'none'
}

/** A turn that did not complete stops the sub-agents still running in it. */
function turnSettled(live: LiveDigest, event: EventOf<'turn_settled'>): When {
  const turn = openTurn(live.digest)
  if (turn) {
    turn.settled = true
    turn.endedAt = Math.max(turn.endedAt, event.settledAt)
  }
  if (live.reply) live.digest.lastReply = live.reply
  live.reply = null
  for (const subagent of live.digest.subagents) {
    if (event.outcome !== 'completed' && subagent.status === 'running') endSubagent(subagent, 'stopped', '', event.settledAt)
  }
  return 'now'
}

function emptyDigest(sessionId: string): SessionDigest {
  return { sessionId, turns: [], changes: null, subagents: [], lastReply: null, updatedAt: 0 }
}

function openTurn(digest: SessionDigest): DigestTurn | null {
  const last = digest.turns.at(-1)
  return last && !last.settled ? last : null
}

function subagentOf(digest: SessionDigest, toolId: string): DigestSubagent | undefined {
  return digest.subagents.find((subagent) => subagent.id === toolId)
}

/** Buckets start at the turn's start, as the timeline's bars do, so a bucket never falls across two bars. */
function countToolCall(turn: DigestTurn, at: number): void {
  const bucket = turn.startedAt + Math.floor(Math.max(0, at - turn.startedAt) / DIGEST_TOOL_BUCKET_MS) * DIGEST_TOOL_BUCKET_MS
  const last = turn.toolCalls.at(-1)
  if (last && last[0] === bucket) last[1] += 1
  else turn.toolCalls.push([bucket, 1])
}

function endSubagent(subagent: DigestSubagent, status: 'completed' | 'failed' | 'stopped', text: string, at: number): void {
  subagent.status = status
  subagent.endedAt = at
  if (text.trim()) subagent.detail = digestLine(text)
}

/** The Agent call's input, as far as a title needs it. */
const subagentInputSchema = z.object({ description: z.string().optional(), prompt: z.string().optional() })

/** The sub-agent's own words for its work, as the conversation names it. */
function subagentTitle(toolInput: string | undefined): string {
  let input: z.infer<typeof subagentInputSchema> = {}
  try {
    input = subagentInputSchema.catch({}).parse(JSON.parse(toolInput ?? '{}'))
  } catch {
    // An input that is still streaming is not JSON yet.
  }
  return digestLine(input.description?.trim() || input.prompt || '') || 'Sub-agent'
}

import { constants, lstatSync, realpathSync } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { NormalizedEvent } from '@solus/contracts/types'
import { parseSubagentInput } from '@solus/contracts/subagent-input'
import type { SessionLoadMessage } from '@solus/contracts/session-history'
import { z } from 'zod'
import type { ProcessUser } from '../../../cli-env'
import { createLogger } from '../../../logger'
import { applyMemberFiles } from '../../seats/member-files'
import { isSubagentTranscriptEvent } from '../subagent-events'
import { KeptHistory, TurnHistory } from '../kept-history'
import { ClaudeTurnNormalizer } from './claude-event-normalizer'
import { resolveClaudeSessionFilePath } from './claude-session-helpers'

const log = createLogger('ClaudeForkedSkills', 'claude-forked-skills.ts')

const forkStart = z.object({
  subtype: z.literal('task_started'), task_type: z.literal('local_agent'),
  task_id: z.string().regex(/^[\w-]+$/), tool_use_id: z.undefined().optional(),
  description: z.string().trim().regex(/^\/\S+$/), prompt: z.string().optional(),
  spawn_depth: z.number().max(1).optional(),
})
const resultFields = z.object({ terminal_reason: z.string().optional() })
const taskSignal = z.object({ subtype: z.string(), task_id: z.string(), status: z.string().optional(), patch: z.object({ status: z.string().optional() }).optional() })
const frame = z.object({ uuid: z.string().optional(), parent_tool_use_id: z.string().nullish() })
const transcriptFrame = frame.extend({
  type: z.enum(['assistant', 'user']), uuid: z.string(),
  message: z.object({ content: z.array(z.looseObject({ type: z.string() })) }),
})
type ForkFrame = z.infer<typeof transcriptFrame> | Extract<SDKMessage, { type: 'assistant' | 'user' }>

const POLL_MS = 1_000
const FINAL_FLUSH_MS = 250
const READ_BYTES = 1024 * 1024

export function claudeForkHistoryPath(file: string): string {
  return join(dirname(file), basename(file, '.jsonl'), 'solus', 'forked-skills.jsonl')
}

function keptForkDirectory(file: string): string | undefined {
  const directory = dirname(claudeForkHistoryPath(file))
  const thread = dirname(directory)
  try {
    const threadDirectory = lstatSync(thread, { throwIfNoEntry: false })
    if (threadDirectory && (!threadDirectory.isDirectory() || realpathSync(thread) !== join(realpathSync(dirname(file)), basename(thread)))) return
    const location = lstatSync(directory, { throwIfNoEntry: false })
    if (location && !location.isDirectory()) return
    for (const name of ['forked-skills.jsonl', 'forked-skills.json']) {
      const history = lstatSync(join(directory, name), { throwIfNoEntry: false })
      if (history && (!history.isFile() || history.nlink !== 1)) return
    }
    return directory
  } catch {
    return undefined
  }
}

/** Insert each fork as one unit at its launch time. Paging still uses Claude's byte cursor. */
export function withClaudeForkedSkills(file: string, messages: SessionLoadMessage[], beforeTime?: number): SessionLoadMessage[] {
  let rows: SessionLoadMessage[]
  try {
    const directory = keptForkDirectory(file)
    rows = directory ? new KeptHistory(directory).read('forked-skills') : []
  } catch {
    return messages
  }
  const groups: Array<{ at: number; parent: string; rows: SessionLoadMessage[] }> = []
  const start = messages[0]?.timestamp ?? 0
  for (const row of rows) {
    if (row.toolId?.startsWith('forked-skill:') && !row.parentToolUseId) {
      const description = parseSubagentInput(row.toolInput).description ?? ''
      groups.push({ at: row.timestamp, parent: 'forked-command-' + description.slice(1), rows: [] })
    }
    groups.at(-1)?.rows.push(row)
  }
  const end = beforeTime ?? Infinity
  const forks = groups.filter((fork) => fork.at >= start && fork.at < end).sort((a, b) => a.at - b.at)
  if (!forks.length) return messages
  const forkParents = new Set(forks.map((fork) => fork.parent))
  let index = 0
  const merged: SessionLoadMessage[] = []
  for (const row of messages) {
    while (index < forks.length && forks[index]!.at < row.timestamp) merged.push(...forks[index++]!.rows)
    if (!row.parentToolUseId || !forkParents.has(row.parentToolUseId)) merged.push(row)
  }
  for (; index < forks.length; index++) merged.push(...forks[index]!.rows)
  return merged
}

interface Fork {
  taskId: string
  parentId: string
  cardId: string
  history: TurnHistory
  normalizer: ClaudeTurnNormalizer
  seen: Set<string>
  offset: number
  discardingLine: boolean
  report: string
  status?: 'completed' | 'failed' | 'stopped'
  drained: boolean
  file?: string
}

/** A fork's SDK frames arrive in a batch after its task notification. Follow the
 * child JSONL first, then accept only unseen assembled frames in that batch. */
export class ClaudeForkedSkills {
  private readonly running = new Map<string, Fork>()
  private readonly started = new Set<string>()
  private readonly byParent = new Map<string, Fork>()

  constructor(
    private readonly projects: string,
    private readonly cwd: string,
    private readonly signal: AbortSignal,
    private readonly persist: boolean,
    private readonly user: ProcessUser | null = null,
  ) {}

  get isFollowing(): boolean {
    return this.running.size > 0
  }

  async poll(sessionId: string | null): Promise<NormalizedEvent[]> {
    const events: NormalizedEvent[] = []
    for (const fork of this.running.values()) {
      if (!fork.drained) events.push(...await this.read(fork, sessionId))
    }
    return events
  }

  async accept(message: SDKMessage, sessionId: string | null): Promise<{ handled: boolean; events: NormalizedEvent[] }> {
    const events: NormalizedEvent[] = []
    const fields = frame.safeParse(message).data ?? {}
    if (message.type === 'result') {
      const reason = resultFields.safeParse(message).data?.terminal_reason
      if (reason !== 'aborted_streaming' && reason !== 'aborted_tools') events.push(...await this.finish(sessionId, true))
    } else if ((message.type === 'assistant' || message.type === 'stream_event' || message.type === 'user') && !fields.parent_tool_use_id) {
      events.push(...await this.finish(sessionId, false))
    }
    if (message.type === 'system') return { handled: await this.observeSystem(message, sessionId, events), events }
    const fork = fields.parent_tool_use_id && this.byParent.get(fields.parent_tool_use_id)
    if (!fork) return { handled: false, events }
    if (message.type === 'assistant' || message.type === 'user') events.push(...this.project(fork, message, fields.uuid))
    return { handled: true, events }
  }

  private async observeSystem(message: SDKMessage, sessionId: string | null, events: NormalizedEvent[]): Promise<boolean> {
    const start = forkStart.safeParse(message)
    if (start.success) {
      if (!this.started.has(start.data.task_id)) events.push(...this.start(start.data))
      return true
    }
    const task = taskSignal.safeParse(message).data
    const fork = task && this.running.get(task.task_id)
    if (!fork || !task) return false
    if (task.subtype === 'task_progress') {
      for (const event of fork.normalizer.push(message)) {
        if (event.type === 'background_task_progress') events.push({ ...event, toolUseId: fork.cardId })
      }
    } else if (task.subtype === 'task_notification' || task.subtype === 'task_updated') {
      const status = task.status ?? task.patch?.status
      if (status === 'completed' || status === 'failed' || status === 'stopped' || status === 'killed') {
        fork.status = status === 'killed' ? 'stopped' : status
        if (task.subtype === 'task_notification') events.push(...await this.drain(fork, sessionId))
      }
    }
    return true
  }

  private start({ task_id: taskId, description, prompt }: z.infer<typeof forkStart>): NormalizedEvent[] {
    this.started.add(taskId)
    const fork: Fork = {
      taskId, parentId: 'forked-command-' + description.slice(1), cardId: 'forked-skill:' + taskId,
      history: new TurnHistory(), normalizer: new ClaudeTurnNormalizer(), seen: new Set(),
      offset: 0, discardingLine: false, report: '', drained: false,
    }
    this.running.set(taskId, fork)
    this.byParent.set(fork.parentId, fork)
    const launch = {
      type: 'tool_call', toolName: 'Agent', toolId: fork.cardId, index: 0, isSubagent: true, subagentType: 'claude',
      toolInput: JSON.stringify({ description, prompt: prompt ?? '' }),
    } satisfies NormalizedEvent
    fork.history.record(launch)
    return [launch, {
      type: 'background_task_started', taskId, toolUseId: fork.cardId, kind: 'subagent', description,
      lineageTask: { kind: 'subagent', title: description },
    }]
  }

  async finish(sessionId: string | null, all: boolean): Promise<NormalizedEvent[]> {
    const events: NormalizedEvent[] = []
    for (const fork of this.running.values()) {
      if (!all && (!fork.status || !fork.drained)) continue
      events.push(...await this.drain(fork, sessionId))
      const status = fork.status ?? 'stopped'
      const report = { type: 'tool_result', toolUseId: fork.cardId, content: fork.report, isSubagentReport: true, isError: status !== 'completed' } satisfies NormalizedEvent
      fork.history.record(report)
      const file = fork.file ?? this.sessionFile(sessionId)
      if (this.persist && file) this.save(file, fork)
      events.push(report, { type: 'background_task_settled', taskId: fork.taskId, status, toolUseId: fork.cardId })
      this.running.delete(fork.taskId)
      this.byParent.delete(fork.parentId)
    }
    return events
  }

  private save(file: string, fork: Fork): void {
    if (!keptForkDirectory(file)) return
    try {
      applyMemberFiles(this.user, [{
        kind: 'append', path: claudeForkHistoryPath(file), mode: 0o600,
        content: fork.history.rows().map((row) => JSON.stringify(row) + '\n').join(''),
      }])
    } catch (error) {
      log.warn('fork_history_write_failed', { taskId: fork.taskId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  private sessionFile(sessionId: string | null): string | null {
    return sessionId && /^[\w-]+$/.test(sessionId)
      ? resolveClaudeSessionFilePath(this.projects, sessionId, this.cwd)
      : null
  }

  private async drain(fork: Fork, sessionId: string | null): Promise<NormalizedEvent[]> {
    if (fork.drained) return []
    const events = await this.read(fork, sessionId)
    if (!this.signal.aborted) {
      await delay(FINAL_FLUSH_MS, undefined, { signal: this.signal }).catch(() => {})
      events.push(...await this.read(fork, sessionId))
    }
    fork.drained = true
    return events
  }

  private async read(fork: Fork, sessionId: string | null): Promise<NormalizedEvent[]> {
    const file = fork.file ?? this.sessionFile(sessionId)
    if (!file || !sessionId) return []
    fork.file = file
    const events: NormalizedEvent[] = []
    const directory = join(dirname(file), sessionId, 'subagents')
    const path = join(directory, `agent-${fork.taskId}.jsonl`)
    try {
      const project = await realpath(dirname(file))
      if (await realpath(directory) !== join(project, sessionId, 'subagents')) return events
      const transcript = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const info = await transcript.stat()
        if (!info.isFile() || info.nlink !== 1) return events
        const bytes = Buffer.allocUnsafe(READ_BYTES)
        // Keep polling bounded, including when a single provider line is too large.
        for (let block = 0; block < 8; block++) {
          const { bytesRead } = await transcript.read(bytes, 0, READ_BYTES, fork.offset)
          const lastNewline = bytes.subarray(0, bytesRead).lastIndexOf(10)
          if (lastNewline < 0) {
            if (bytesRead === READ_BYTES) {
              fork.offset += bytesRead
              fork.discardingLine = true
              continue
            }
            break
          }
          const start = fork.discardingLine ? bytes.subarray(0, bytesRead).indexOf(10) + 1 : 0
          fork.discardingLine = false
          fork.offset += lastNewline + 1
          for (const line of bytes.toString('utf8', start, lastNewline + 1).split('\n')) {
            if (!line) continue
            try {
              const parsed = transcriptFrame.safeParse(JSON.parse(line))
              // The validated envelope is the same assistant/user shape the SDK uses.
              if (parsed.success) events.push(...this.project(fork, parsed.data, parsed.data.uuid))
            } catch {
              // A malformed line cannot block later activity.
            }
          }
          if (bytesRead < READ_BYTES) break
        }
      } finally {
        await transcript.close()
      }
    } catch {
      // Claude may not have created the child's file yet.
    }
    return events
  }

  private project(fork: Fork, message: ForkFrame, uuid?: string): NormalizedEvent[] {
    if (uuid && fork.seen.has(uuid)) return []
    const scoped = { ...message, parent_tool_use_id: fork.cardId }
    const events = fork.normalizer.push(scoped).filter(isSubagentTranscriptEvent)
    if (uuid && events.length) fork.seen.add(uuid)
    for (const event of events) {
      if (event.type === 'assistant_message') fork.report = event.text
      fork.history.record(event)
    }
    return events
  }
}

/** Keep one SDK read pending while the fork's file changes independently. */
export async function* claudeMessagesWithForkPoll(query: AsyncIterable<SDKMessage>, forks: ClaudeForkedSkills): AsyncGenerator<SDKMessage | null> {
  const iterator = query[Symbol.asyncIterator]()
  try {
    let next = iterator.next()
    let pollAt = Date.now() + POLL_MS
    while (true) {
      if (!forks.isFollowing) pollAt = Date.now() + POLL_MS
      if (forks.isFollowing && Date.now() >= pollAt) {
        pollAt = Date.now() + POLL_MS
        yield null
        continue
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      const result = await (forks.isFollowing ? Promise.race([
        next, new Promise<null>((resolve) => { timer = setTimeout(resolve, Math.max(0, pollAt - Date.now()), null) }),
      ]) : next).finally(() => clearTimeout(timer))
      if (result === null) {
        pollAt = Date.now() + POLL_MS
        yield null
      } else {
        if (result.done) return
        yield result.value
        next = iterator.next()
      }
    }
  } finally {
    await iterator.return?.()
  }
}

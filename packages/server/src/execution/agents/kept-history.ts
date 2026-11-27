import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { startsHistoryTurn, type ProviderHistoryPage, type SessionLoadMessage } from '@solus/contracts/session-history'
import { formatExchangeTag, formatSessionReport } from '@solus/contracts/session-exchange'
import { attributionSchema } from '@solus/contracts/user'
import type { AgentConversationUpdate, NormalizedEvent } from '@solus/contracts/types'
import { createLogger } from '../../logger'

const log = createLogger('KeptHistory', 'kept-history.ts')

const rowSchema = z.object({
  role: z.string(),
  content: z.string(),
  timestamp: z.number(),
  toolName: z.string().optional(),
  toolId: z.string().optional(),
  toolInput: z.string().optional(),
  toolStatus: z.enum(['running', 'completed', 'error']).optional(),
  isSubagent: z.boolean().optional(),
  subagentType: z.string().optional(),
  parentToolUseId: z.string().optional(),
  sender: attributionSchema.transform((sender) =>
    sender.kind === 'agent' || sender.kind === 'automation' ? sender : undefined,
  ).optional(),
  planContent: z.string().optional(),
  planToolUseId: z.string().optional(),
})
const historySchema = z.array(rowSchema)

/**
 * The transcript rows that Solus keeps for a provider whose own history it
 * does not read: the replay backend, and the ACP backend
 * (docs/plans/antigravity-provider.md §5.4). One file per provider thread, a
 * row on each line: a turn only appends, so the session cloud copy carries the
 * file as it carries a provider's own (`threadFiles`). A file from before that
 * holds one JSON array; the first append moves its rows to the new file.
 */
export class KeptHistory {
  constructor(private readonly directory: string) {}

  /** The thread's file name, also its name in a session's cloud copy. */
  fileName(threadId: string): string {
    return `${threadId.replace(/[^\w-]/g, '_')}.jsonl`
  }

  /** The thread's file on this host. */
  file(threadId: string): string {
    return join(this.directory, this.fileName(threadId))
  }

  private legacyFile(threadId: string): string {
    return join(this.directory, `${threadId.replace(/[^\w-]/g, '_')}.json`)
  }

  read(threadId: string): SessionLoadMessage[] {
    const file = this.file(threadId)
    if (existsSync(file)) return this.readLines(file)
    const legacy = this.legacyFile(threadId)
    if (!existsSync(legacy)) return []
    try {
      return historySchema.parse(JSON.parse(readFileSync(legacy, 'utf8')))
    } catch (error) {
      log.warn('kept_history_unreadable', { file: legacy, error: error instanceof Error ? error.message : String(error) })
      return []
    }
  }

  /** A line that does not parse, such as one a crash cut short, is left out; the others still read. */
  private readLines(file: string): SessionLoadMessage[] {
    const rows: SessionLoadMessage[] = []
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const row = rowSchema.safeParse(JSON.parse(line))
        if (row.success) rows.push(row.data)
      } catch {
        log.warn('kept_history_line_unreadable', { file })
      }
    }
    return rows
  }

  append(threadId: string, rows: SessionLoadMessage[]): void {
    try {
      mkdirSync(this.directory, { recursive: true })
      const file = this.file(threadId)
      const legacy = this.legacyFile(threadId)
      const earlier = !existsSync(file) && existsSync(legacy) ? this.read(threadId) : []
      const lines = [...earlier, ...rows].map((row) => `${JSON.stringify(row)}\n`).join('')
      if (earlier.length) writeFileSync(file, lines)
      else appendFileSync(file, lines)
      if (earlier.length) unlinkSync(legacy)
    } catch (error) {
      log.warn('kept_history_write_failed', { error: error instanceof Error ? error.message : String(error) })
    }
  }

  load(threadId: string, limit?: number): SessionLoadMessage[] {
    const rows = this.read(threadId)
    return limit === undefined ? rows : rows.slice(-limit)
  }

  firstTurn(threadId: string): SessionLoadMessage[] {
    const rows = this.read(threadId)
    const first = rows.findIndex(startsHistoryTurn)
    const second = first < 0 ? -1 : rows.findIndex((row, index) => index > first && startsHistoryTurn(row))
    return second < 0 ? rows : rows.slice(0, second)
  }

  /** `before` is the index of the first row of the page after this one. */
  page(threadId: string, turnLimit: number, before?: string): ProviderHistoryPage {
    const rows = this.read(threadId)
    const end = before === undefined ? rows.length : Math.max(0, Math.min(rows.length, Number(before)))
    let start = end
    let turns = 0
    while (start > 0 && turns < turnLimit) {
      start -= 1
      if (startsHistoryTurn(rows[start]!)) turns += 1
    }
    return { messages: rows.slice(start, end), before: start > 0 ? String(start) : null }
  }
}

/** The rows one turn adds to its session's kept history. */
export class TurnHistory {
  private readonly messages: SessionLoadMessage[] = []
  private readonly tools = new Map<string, SessionLoadMessage>()
  private readonly exchanges = new Map<string, SessionLoadMessage>()
  private text: SessionLoadMessage | null = null
  /** The turn's own prose, which is its result. */
  resultText = ''

  constructor(prompt?: string) {
    if (prompt === undefined) return
    this.messages.push({ role: 'user', content: prompt, timestamp: Date.now() })
  }

  record(event: NormalizedEvent): void {
    if (event.type === 'text_chunk') this.recordText(event)
    else if (event.type === 'assistant_message' && event.parentToolUseId) {
      this.push({ role: 'assistant', content: event.text, parentToolUseId: event.parentToolUseId, timestamp: Date.now() })
    } else if (event.type === 'user_message') {
      this.push({ role: 'user', content: event.text, sender: event.sender, timestamp: Date.now() })
    } else if (event.type === 'agent_conversation_update') this.recordExchange(event.update)
    else if (event.type === 'tool_call') this.recordToolCall(event)
    else if (event.type === 'tool_call_update' || event.type === 'tool_call_complete' || event.type === 'tool_result') this.recordToolProgress(event)
    else if (event.type === 'thinking' && event.state === 'stop' && event.text) this.push({ role: 'reasoning', content: event.text, timestamp: Date.now() })
    else if (event.type === 'plan' && event.planContent.trim()) {
      const row: SessionLoadMessage = { role: 'plan', content: '', planContent: event.planContent, timestamp: Date.now() }
      if (event.planToolUseId) row.planToolUseId = event.planToolUseId
      this.push(row)
    }
  }

  /** Store the same tool receipt that the history projection uses to rebuild an agent card. */
  private recordExchange(update: AgentConversationUpdate): void {
    if (update.phase === 'dispatched') {
      const started = update.origin === 'created'
      const row: SessionLoadMessage = {
        role: 'tool',
        toolId: update.messageId,
        toolName: started ? 'start_sessions' : 'send_session',
        toolStatus: 'completed',
        toolInput: JSON.stringify(started
          ? { sessions: [{ title: update.title, prompt: update.prompt, agent_provider: update.provider }] }
          : { session_id: update.sessionId, message: update.prompt }),
        content: formatExchangeTag({
          messageId: update.messageId,
          sessionId: update.sessionId,
          provider: update.provider,
          serverId: update.serverId,
          item: started ? 0 : undefined,
        }),
        timestamp: update.dispatchedAt,
      }
      this.exchanges.set(update.messageId, row)
      this.push(row)
    } else if (update.phase === 'settled') {
      const row = this.exchanges.get(update.messageId)
      if (!row) return
      row.content += '\n\n' + formatSessionReport({
        messageId: update.messageId,
        sessionId: update.sessionId,
        status: update.status,
        durationMs: update.durationMs,
        outputs: update.outputs ?? [],
        reply: update.replyText,
      })
      this.exchanges.delete(update.messageId)
    }
  }

  /** A row that is not prose: the prose after it starts a new row. */
  private push(row: SessionLoadMessage): void {
    this.text = null
    this.messages.push(row)
  }

  private recordText(event: Extract<NormalizedEvent, { type: 'text_chunk' }>): void {
    // A sub-agent's prose belongs to its own transcript, not this turn's answer.
    if (event.parentToolUseId) return
    this.resultText += event.text
    if (!this.text) {
      this.text = { role: 'assistant', content: '', timestamp: Date.now() }
      this.messages.push(this.text)
    }
    this.text.content += event.text
  }

  private recordToolCall(event: Extract<NormalizedEvent, { type: 'tool_call' }>): void {
    const row: SessionLoadMessage = { role: 'tool', content: event.content ?? '', toolName: event.toolName, toolId: event.toolId, toolStatus: 'running', timestamp: Date.now() }
    if (event.toolInput !== undefined) row.toolInput = event.toolInput
    if (event.parentToolUseId) row.parentToolUseId = event.parentToolUseId
    if (event.isSubagent) row.isSubagent = true
    if (event.subagentType) row.subagentType = event.subagentType
    this.tools.set(event.toolId, row)
    this.push(row)
  }

  private recordToolProgress(event: Extract<NormalizedEvent, { type: 'tool_call_update' | 'tool_call_complete' | 'tool_result' }>): void {
    const toolId = event.type === 'tool_result' ? event.toolUseId : event.toolId
    const row = toolId ? this.tools.get(toolId) : undefined
    if (!row) return
    if (event.type === 'tool_result') {
      if (event.isAsyncLaunch && !event.isError) return
      row.content = event.content
      row.toolStatus = event.isError ? 'error' : 'completed'
      return
    }
    if (event.toolInput !== undefined) row.toolInput = event.toolInput
    if (event.type === 'tool_call_update' && event.content !== undefined) row.content += event.content
    if (event.type === 'tool_call_complete' && event.outcome) row.toolStatus = event.outcome.status === 'failed' ? 'error' : 'completed'
  }

  rows(): SessionLoadMessage[] {
    // A tool the turn never finished reads as finished once the turn is over.
    for (const row of this.tools.values()) if (row.toolStatus === 'running') row.toolStatus = 'completed'
    return this.messages
  }
}

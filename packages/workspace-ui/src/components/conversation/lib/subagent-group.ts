import { MODEL_PROFILES, REASONING_EFFORT_LABELS, type Message } from '@solus/contracts/types'
import { getToolDescription, participleFor } from './activity-summary'
import { parseSubagentInput, subagentTodos } from './subagent'
import { z } from 'zod'

/**
 * §18 — a fan-out is one object, not n cards. Everything the group card and its
 * rows print is derived here, so the markup stays geometry.
 */

export type SubagentRowState = 'running' | 'done' | 'failed'

/**
 * Steps the rail prints. An agent that keeps a todo list gives a real
 * denominator (`5/8`); one that never wrote a plan has only the tool calls it
 * has run, so `total` is 0 and the rail prints the bare count rather than
 * inventing a fraction.
 */
export interface SubagentSteps {
  done: number
  total: number
}

export interface SubagentRow {
  id: string
  /** The surface the agent owns — its own description, never a number. */
  name: string
  state: SubagentRowState
  /** Participle while live, the agent's result as a fact once it lands. */
  activity: string
  /** What the live step is on. Mono, truncates, empty once settled. */
  target: string
  steps: SubagentSteps
  /** Model and effort. Agents in one fan-out are routinely dispatched with
   *  different ones, so this varies and therefore lives on the row. */
  meta: string
  elapsedMs: number
}

export interface SubagentGroupSummary {
  total: number
  running: number
  failed: number
  /** Agents that are neither running nor failed. */
  done: number
  elapsedMs: number
  /** The shared objective, with the count. */
  title: string
  /** Counts, never names. */
  chip: string
  /** Only what every agent genuinely shares: the count, where they run, and a
   *  tally of how many are in each state. Anything that varies is on the row. */
  meta: string[]
}

export interface SubagentModelFallback {
  model: string
  effort: string
}

export interface SubagentLiveStep {
  activity: string
  target: string
}

const reasoningEffortSchema = z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode'])

export function subagentState(message: Message): SubagentRowState {
  // toolStatus tracks the agent, not its tool call: a backgrounded agent's
  // tool_result lands at launch, so only toolStatus says "still working".
  if (message.toolStatus === 'running') return 'running'
  if (message.toolStatus === 'error') return 'failed'
  return 'done'
}

/**
 * The agent's own plan is the only thing that knows how many steps there are.
 * Without one, fall back to the tool calls it has run — a count with no
 * denominator, which the rail prints bare rather than inventing a fraction.
 */
function stepsFor(message: Message, subs: Message[]): SubagentSteps {
  const todos = subagentTodos(message)
  if (todos.length > 0) {
    return { done: todos.filter((todo) => todo.status === 'completed').length, total: todos.length }
  }
  const observedToolUses = subs.reduce((count, m) => (m.role === 'tool' ? count + 1 : count), 0)
  return {
    done: Math.max(observedToolUses, message.backgroundTaskProgress?.toolUses ?? 0),
    total: 0,
  }
}

function lastRunningTool(subs: Message[]): Message | undefined {
  for (let i = subs.length - 1; i >= 0; i--) {
    if (subs[i].role === 'tool') return subs[i]
  }
  return undefined
}

/**
 * What the agent is doing this second: the participle for the call in flight and
 * the target that call names. A backgrounded agent describes its own step, and
 * that description wins — it is the agent's word for the work, not ours.
 */
export function subagentLiveStep(message: Message): SubagentLiveStep {
  const progress = message.backgroundTaskProgress
  const description = progress?.description?.trim() ?? ''
  if (description) return { activity: description, target: '' }

  const live = lastRunningTool(message.subMessages ?? [])
  return {
    activity: participleFor(live?.toolName || progress?.lastToolName),
    // The participle already carries the verb, so drop the description's own.
    target: live
      ? getToolDescription(live.toolName || 'Tool', live.toolInput)
        .replace(/^(Read|Edit|Write|Search files|Search|Fetch)[:\s]+/i, '')
        .trim()
      : '',
  }
}

/** The agent's answer as a fact — one line, never the whole result. */
function resultSummary(message: Message, subs: Message[]): string {
  // A backgrounded agent never returns a tool_result, so fall back to the last
  // thing it said in its own transcript — that is its answer.
  const text =
    message.report ||
    subs.findLast((m) => m.role === 'assistant' && m.content.trim())?.content ||
    ''
  const first = text
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean)
  if (!first) return 'Done'
  return first.length > 120 ? `${first.slice(0, 117)}…` : first
}

export function subagentName(message: Message): string {
  const parsed = parseSubagentInput(message.toolInput)
  return (parsed.description || parsed.prompt || 'Sub-agent').trim()
}

export function subagentRow(
  message: Message,
  now: number,
  fallback: SubagentModelFallback,
): SubagentRow {
  const subs = message.subMessages ?? []
  const state = subagentState(message)
  const taskProgress = state === 'running' ? message.backgroundTaskProgress : undefined
  const live = state === 'running' ? subagentLiveStep(message) : null

  return {
    id: message.id,
    name: subagentName(message),
    state,
    activity: live ? live.activity : resultSummary(message, subs),
    target: live?.target ?? '',
    steps: stepsFor(message, subs),
    meta: [namedType(message), ...subagentModelMeta(message, fallback)].filter(Boolean).join(' · '),
    elapsedMs: Math.max(
      0,
      (state === 'running' ? now : (message.toolCompletedAt ?? message.timestamp)) - message.timestamp,
      taskProgress?.durationMs ?? message.backgroundTaskProgress?.durationMs ?? 0,
    ),
  }
}

/**
 * Model and effort for a sub-agent: whatever the Agent call asked for, else the
 * default of the backend it names, else what the parent session is running.
 */
export function subagentModelMeta(message: Message, fallback: SubagentModelFallback): string[] {
  const parsed = parseSubagentInput(message.toolInput)
  const backend =
    message.subagentType === 'codex' ? 'codex' : message.subagentType === 'claude' ? 'claude-code' : ''
  const defaultModel = backend
    ? (Object.entries(MODEL_PROFILES[backend] ?? {}).find(([, profile]) => profile.isDefault)?.[0] ?? '')
    : ''

  const model = (parsed.model || defaultModel || fallback.model).trim()
  const effort = (parsed.reasoning_effort || (backend ? 'high' : fallback.effort) || '').trim()
  const parsedEffort = reasoningEffortSchema.safeParse(effort)
  const effortLabel = parsedEffort.success ? REASONING_EFFORT_LABELS[parsedEffort.data] : effort

  return [model, effortLabel].filter(Boolean)
}

function subagentTypeOf(message: Message): string {
  return (message.subagentType || parseSubagentInput(message.toolInput).subagent_type || '').trim()
}

/** The agent type, but only when it names something — "agent" says nothing a
 *  reader of a sub-agent row doesn't already know. */
function namedType(message: Message): string {
  const type = subagentTypeOf(message)
  return type === 'agent' || type === 'general-purpose' ? '' : type
}

/** The shared objective: the one thing every agent in the fan-out has in common. */
function groupTitle(messages: Message[]): string {
  const types = new Set(messages.map(namedType))
  const shared = types.size === 1 ? [...types][0] : ''
  return `${messages.length} ${shared ? `${shared} ` : ''}agents in parallel`
}

/**
 * The header carries only what is genuinely shared. The tally is the one place
 * the mixed states are spelled out, so it is dropped when every agent is in the
 * same state — there the chip has already said it.
 */
function tallyOf(done: number, running: number, failed: number): string {
  const parts = [
    done > 0 ? `${done} done` : '',
    running > 0 ? `${running} running` : '',
    failed > 0 ? `${failed} failed` : '',
  ].filter(Boolean)
  return parts.length > 1 ? parts.join(', ') : ''
}

export function subagentGroupSummary(
  messages: Message[],
  rows: SubagentRow[],
  now: number,
  /** Where they all run — the one environment fact the fan-out shares. */
  worktree: string,
): SubagentGroupSummary {
  let running = 0
  let failed = 0
  let startedAt = Infinity
  let settledAt = -Infinity

  for (const row of rows) {
    if (row.state === 'running') running++
    else if (row.state === 'failed') failed++
  }
  for (const message of messages) {
    startedAt = Math.min(startedAt, message.timestamp)
    settledAt = Math.max(settledAt, message.toolCompletedAt ?? message.timestamp)
  }

  const done = messages.length - running - failed
  const chip =
    running > 0
      ? `${running} running`
      : failed > 0
        ? `${done} done · ${failed} failed`
        : `${messages.length} done`

  return {
    total: messages.length,
    running,
    failed,
    done,
    elapsedMs: Math.max(0, (running > 0 ? now : settledAt) - startedAt),
    title: groupTitle(messages),
    chip,
    meta: [
      `${messages.length} agent${messages.length === 1 ? '' : 's'}`,
      worktree ? `worktree ${worktree}` : '',
      tallyOf(done, running, failed),
    ].filter(Boolean),
  }
}

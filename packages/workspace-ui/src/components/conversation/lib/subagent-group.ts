import { MODEL_PROFILES, REASONING_EFFORT_LABELS, modelLabelFor, type AgentId, type Message } from '@solus/contracts/types'
import { getToolDescription, participleFor } from './activity-summary'
import { parseSubagentInput } from './subagent'
import { z } from 'zod'

/**
 * §18 — a fan-out is one object, not n cards. Everything the group card and its
 * rows print is derived here, so the markup stays geometry.
 */

export type SubagentRowState = 'running' | 'done' | 'failed'

export interface SubagentRow {
  id: string
  /** The surface the agent owns — its own description, never a number. */
  name: string
  state: SubagentRowState
  /** Participle while live, the agent's result as a fact once it lands. */
  activity: string
  /** What the live step is on. Mono, truncates, empty once settled. */
  target: string
  /** The backend the agent runs on, for its mark on the card line. */
  provider: AgentId
  /** The model's display name, or empty when nothing names one. */
  modelLabel: string
  /** The reasoning effort's display name, or empty when nothing names one. */
  effortLabel: string
  elapsedMs: number
}

export interface SubagentGroupSummary {
  total: number
  running: number
  failed: number
  /** Agents that are neither running nor failed. */
  done: number
  elapsedMs: number
  /** The group header's label: `3 subagents`. */
  title: string
  /** Counts, never names. */
  chip: string
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
    ...subagentIdentity(message, fallback),
    elapsedMs: Math.max(
      0,
      (state === 'running' ? now : (message.toolCompletedAt ?? message.timestamp)) - message.timestamp,
      taskProgress?.durationMs ?? message.backgroundTaskProgress?.durationMs ?? 0,
    ),
  }
}

/**
 * Which backend a sub-agent runs on and its model's name. The Agent call names
 * the backend when it is not the parent's; otherwise the model says which
 * provider's profile it belongs to.
 */
export function subagentIdentity(
  message: Message,
  fallback: SubagentModelFallback,
): { provider: AgentId; modelLabel: string; effortLabel: string } {
  const [model = '', effortLabel = ''] = subagentModelMeta(message, fallback)
  const provider: AgentId =
    message.subagentType === 'codex'
      ? 'codex'
      : message.subagentType === 'claude'
        ? 'claude-code'
        : model in (MODEL_PROFILES.codex ?? {})
          ? 'codex'
          : 'claude-code'
  return { provider, modelLabel: modelLabelFor(provider, model) ?? '', effortLabel }
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

export function subagentGroupSummary(
  messages: Message[],
  rows: SubagentRow[],
  now: number,
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
    title: `${messages.length} subagent${messages.length === 1 ? '' : 's'}`,
    chip,
  }
}

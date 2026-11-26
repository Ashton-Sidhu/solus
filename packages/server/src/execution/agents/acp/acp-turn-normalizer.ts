import { resolve } from 'node:path'
import { z } from 'zod'
import type { NormalizedEvent, TodoItem } from '@solus/contracts/types'
import type { TurnNormalizer, TurnSummary } from '../turn-normalizer'
import type { AcpSessionUpdate, AcpToolCall, AcpToolCallContent } from './acp-protocol'

type JsonValue = AcpToolCall['rawInput']

/** How a tool call shows in the transcript: the card it gets and its input. */
export interface AcpToolPresentation {
  toolName: string
  toolInput?: string
  /** The call starts a subagent: it shows as a subagent card of this type. */
  isSubagent?: boolean
  subagentType?: string
}

/** An agent's own names for its tools: `null` leaves the call to the generic rule. */
export type AcpToolNamer = (toolCall: AcpToolCall) => AcpToolPresentation | null

/**
 * An agent that reports its checklist as a tool call, not as an ACP `plan`:
 * which call carries it, and its steps. The later updates of that call name it
 * by id only.
 */
export interface AcpStepsTool {
  isStepsCall(toolCall: AcpToolCall): boolean
  /** The steps in the call's input; null when this update carries none. */
  stepsOf(rawInput: AcpToolCall['rawInput']): TodoItem[] | null
}

/** An agent that writes its plan as a file in plan mode: the plan a call writes, else null. */
export interface AcpPlanTool {
  planOf(toolCall: AcpToolCall): { content: string; path: string } | null
}

/** Where the calls of an agent's subagents go: into the card of the subagent that made them. */
export interface AcpChildCalls {
  /** Takes each call of the turn: a subagent launch is a card its children can name. */
  note(toolCall: AcpToolCall): void
  /** The card a call belongs in; null for a call of the agent itself. */
  parentOf(toolCallId: string): string | null
}

/** What one turn adds to the generic rules: plan mode's plan file, and the subagents' own calls. */
export interface AcpTurnHooks {
  planTool?: AcpPlanTool | null
  childCalls?: AcpChildCalls | null
}

interface ToolState {
  index: number
  /** The card of the subagent that made the call. */
  parent: string | null
  kind: AcpToolCall['kind']
  title: string | null
  rawInput: JsonValue | undefined
  locations: AcpToolCall['locations']
  diff: Extract<AcpToolCallContent, { type: 'diff' }> | null
  output: string
  done: boolean
}

const MAX_TOOL_NAME = 80
/** A command can print far more than a card shows; its tail holds the result and the error. */
const MAX_TOOL_OUTPUT = 64 * 1024
const OUTPUT_CUT = '[Earlier output left out]\n\n'

/** The output's tail, cut where no UTF-16 pair is split (T3 Code's rule in `AntigravityProtocol.ts`). */
export function boundToolOutput(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT) return text
  return OUTPUT_CUT + text.slice(-MAX_TOOL_OUTPUT).replace(/^[\uDC00-\uDFFF]/, '')
}

/** The names agents give a command, a path, and an output in a tool's raw input and output. */
const commandInputSchema = z.looseObject({ command: z.string().optional(), CommandLine: z.string().optional(), cmd: z.string().optional() })
const pathInputSchema = z.looseObject({ path: z.string().optional(), file_path: z.string().optional(), filePath: z.string().optional(), absolute_path: z.string().optional() })
const outputFieldsSchema = z.looseObject({ output: z.string().optional(), stdout: z.string().optional(), content: z.string().optional(), result: z.string().optional() })

function commandOf(rawInput: JsonValue | undefined): string | null {
  const input = commandInputSchema.safeParse(rawInput)
  return input.success ? input.data.command || input.data.CommandLine || input.data.cmd || null : null
}

function pathOf(rawInput: JsonValue | undefined): string | null {
  const input = pathInputSchema.safeParse(rawInput)
  return input.success ? input.data.path || input.data.file_path || input.data.filePath || input.data.absolute_path || null : null
}

/**
 * The Solus card for an ACP tool call, from its kind: the shapes the clients
 * already draw for Claude's tools. Anything else keeps the agent's own title.
 */
export function presentAcpTool(tool: Pick<ToolState, 'kind' | 'title' | 'rawInput' | 'locations' | 'diff'>): AcpToolPresentation {
  const path = tool.diff?.path ?? tool.locations?.[0]?.path ?? pathOf(tool.rawInput)
  // A card keeps the name it started with, and an edit's diff often comes after
  // its start: an edit is an `Edit` card from the start, and its input fills in.
  if (tool.kind === 'edit') {
    if (!tool.diff) return path ? { toolName: 'Edit', toolInput: JSON.stringify({ file_path: path }) } : { toolName: 'Edit' }
    return { toolName: 'Edit', toolInput: JSON.stringify({ file_path: tool.diff.path, old_string: tool.diff.oldText ?? '', new_string: tool.diff.newText }) }
  }
  if (tool.kind === 'execute') {
    const command = commandOf(tool.rawInput) ?? tool.title ?? ''
    return { toolName: 'Bash', toolInput: JSON.stringify({ command }) }
  }
  if (tool.kind === 'read' && path) return { toolName: 'Read', toolInput: JSON.stringify({ file_path: path }) }
  const title = (tool.title ?? '').trim()
  const toolName = title ? (title.length > MAX_TOOL_NAME ? `${title.slice(0, MAX_TOOL_NAME - 1)}…` : title) : tool.kind ?? 'Tool'
  return tool.rawInput === undefined ? { toolName } : { toolName, toolInput: JSON.stringify(tool.rawInput) }
}

function contentText(content: AcpToolCall['content']): string {
  let text = ''
  for (const item of content ?? []) {
    if (item.type === 'content' && item.content.text) text += item.content.text
  }
  return text
}

function outputText(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return ''
  const text = z.string().safeParse(value)
  if (text.success) return text.data
  const fields = outputFieldsSchema.safeParse(value)
  const field = fields.success ? fields.data.output || fields.data.stdout || fields.data.content || fields.data.result : undefined
  return field || JSON.stringify(value)
}

/**
 * One turn of `session/update` notifications as Solus events
 * (docs/plans/antigravity-provider.md §5.2). One instance per turn.
 */
export class AcpTurnNormalizer implements TurnNormalizer<AcpSessionUpdate> {
  private readonly tools = new Map<string, ToolState>()
  private thought: { id: string; text: string } | null = null
  private nextThought = 1
  private interrupted = false
  readonly summary: TurnSummary = { toolCallCount: 0, sawRateLimit: false, sawProtocolError: false, permissionDenials: [] }

  /** The ids of the open calls that carry the agent's checklist. */
  private readonly stepsCalls = new Set<string>()
  /** The open calls that write the plan, with the plan: a later update names the call by id only. */
  private readonly planCalls = new Map<string, { content: string; path: string }>()

  constructor(
    private readonly nameTool: AcpToolNamer = () => null,
    private readonly stepsTool: AcpStepsTool | null = null,
    private readonly hooks: AcpTurnHooks = {},
  ) {}

  push(update: AcpSessionUpdate): NormalizedEvent[] {
    if (this.interrupted) return []
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = update.content.text
        if (update.content.type !== 'text' || !text) return []
        return [...this.closeThought(), { type: 'text_chunk', text, streaming: true }]
      }
      case 'agent_thought_chunk': {
        const text = update.content.text
        if (update.content.type !== 'text' || !text) return []
        const events: NormalizedEvent[] = []
        if (!this.thought) {
          this.thought = { id: `thought-${this.nextThought++}`, text: '' }
          events.push({ type: 'thinking', state: 'start', thoughtId: this.thought.id })
        }
        this.thought.text += text
        events.push({ type: 'thinking', state: 'update', thoughtId: this.thought.id, text: this.thought.text })
        return events
      }
      case 'tool_call':
      case 'tool_call_update': {
        if (this.stepsTool && (this.stepsCalls.has(update.toolCallId) || this.stepsTool.isStepsCall(update))) return this.pushSteps(update, this.stepsTool)
        const plan = this.pushPlan(update)
        if (plan) return plan
        this.hooks.childCalls?.note(update)
        const started = this.startTool(update)
        return [...this.closeThought(), ...started, ...this.updateTool(update, started.length > 0)]
      }
      case 'plan':
        return [{ type: 'progress', todos: update.entries.map((entry) => ({ content: entry.content, status: entry.status })) }]
      case 'usage_update':
        return [{ type: 'usage', context: { usedTokens: update.used, windowTokens: update.size } }]
      default:
        return []
    }
  }

  /** Whether a tool call of the turn has not ended yet. */
  get hasOpenTools(): boolean {
    for (const tool of this.tools.values()) if (!tool.done) return true
    return false
  }

  interrupt(): void {
    this.interrupted = true
  }

  /** The events that close the turn's open blocks once its prompt answered. */
  finish(): NormalizedEvent[] {
    return this.interrupted ? [] : this.closeThought()
  }

  /**
   * A file read the client served completes the agent's own open read call of
   * that file. agy never completes a subagent's read, then fails it with the
   * next unrelated error (T3 Code's read repair).
   */
  completeServedRead(path: string, isClientRead: (title: string) => boolean): NormalizedEvent[] {
    for (const [toolCallId, tool] of this.tools) {
      const target = tool.locations?.[0]?.path ?? pathOf(tool.rawInput)
      if (tool.done || !tool.title || !isClientRead(tool.title) || !target || resolve(target) !== path) continue
      return this.updateTool({ toolCallId, status: 'completed' }, false)
    }
    return []
  }

  /** A checklist call shows as the session's task list, not as a tool card. */
  private pushSteps(update: AcpToolCall, stepsTool: AcpStepsTool): NormalizedEvent[] {
    if (update.status === 'completed' || update.status === 'failed') this.stepsCalls.delete(update.toolCallId)
    else this.stepsCalls.add(update.toolCallId)
    const todos = stepsTool.stepsOf(update.rawInput)
    return todos ? [...this.closeThought(), { type: 'progress', todos }] : []
  }

  /** In plan mode, the call that writes the plan is the plan card, not a tool card; null for any other call. */
  private pushPlan(update: AcpToolCall): NormalizedEvent[] | null {
    const plan = this.planCalls.get(update.toolCallId) ?? this.hooks.planTool?.planOf(update)
    if (!plan) return null
    this.planCalls.set(update.toolCallId, plan)
    if (update.status !== 'completed' && update.status !== 'failed') return []
    this.planCalls.delete(update.toolCallId)
    if (update.status === 'failed') return []
    const toolCallId = update.toolCallId
    return [...this.closeThought(), { type: 'plan', planContent: plan.content, planFilePath: plan.path, questionId: toolCallId, options: [], planToolUseId: toolCallId }]
  }

  private closeThought(): NormalizedEvent[] {
    const thought = this.thought
    if (!thought) return []
    this.thought = null
    return [{ type: 'thinking', state: 'stop', thoughtId: thought.id, text: thought.text }]
  }

  private presentation(tool: ToolState, toolCall: AcpToolCall): AcpToolPresentation {
    return this.nameTool(toolCall) ?? presentAcpTool(tool)
  }

  /** A `tool_call`, or the first update of a call the agent never announced. */
  private startTool(toolCall: AcpToolCall): NormalizedEvent[] {
    if (this.tools.has(toolCall.toolCallId)) return []
    const tool: ToolState = {
      index: this.summary.toolCallCount,
      parent: this.hooks.childCalls?.parentOf(toolCall.toolCallId) ?? null,
      kind: toolCall.kind ?? 'other',
      title: toolCall.title ?? null,
      rawInput: toolCall.rawInput,
      locations: toolCall.locations,
      diff: null,
      output: '',
      done: false,
    }
    this.tools.set(toolCall.toolCallId, tool)
    this.summary.toolCallCount += 1
    const { toolName, toolInput, isSubagent, subagentType } = this.presentation(tool, toolCall)
    const event: NormalizedEvent = { type: 'tool_call', toolName, toolId: toolCall.toolCallId, index: tool.index, startedAtMs: Date.now() }
    if (toolInput !== undefined) event.toolInput = toolInput
    if (tool.parent) event.parentToolUseId = tool.parent
    if (isSubagent) {
      event.isSubagent = true
      if (subagentType) event.subagentType = subagentType
    }
    return [event]
  }

  /** Takes what an update changed of a call's input; true when the card's input changed. */
  private mergeInput(tool: ToolState, toolCall: AcpToolCall, justStarted: boolean): boolean {
    let changed = false
    // A `tool_call` event already carried the call's title and input.
    if (!justStarted) {
      if (toolCall.kind) tool.kind = toolCall.kind
      if (toolCall.title) { tool.title = toolCall.title; changed = true }
      if (toolCall.rawInput !== undefined) { tool.rawInput = toolCall.rawInput; changed = true }
      if (toolCall.locations?.length) { tool.locations = toolCall.locations; changed = true }
    }
    const diff = toolCall.content?.find((item): item is Extract<AcpToolCallContent, { type: 'diff' }> => item.type === 'diff')
    if (diff) { tool.diff = diff; changed = true }
    return changed
  }

  /** `justStarted`: the `tool_call` event already carried the call's title and input. */
  private updateTool(toolCall: AcpToolCall, justStarted: boolean): NormalizedEvent[] {
    const tool = this.tools.get(toolCall.toolCallId)
    if (!tool || tool.done) return []
    const events: NormalizedEvent[] = []
    const inputChanged = this.mergeInput(tool, toolCall, justStarted)
    // An update's `content` replaces the call's content (ACP): agy sends a command's output whole each time.
    const text = contentText(toolCall.content)
    if (text) tool.output = boundToolOutput(text)
    if (inputChanged || text) {
      const update: NormalizedEvent = { type: 'tool_call_update', toolId: toolCall.toolCallId, index: tool.index }
      if (tool.parent) update.parentToolUseId = tool.parent
      if (inputChanged) {
        const { toolInput } = this.presentation(tool, toolCall)
        if (toolInput !== undefined) update.toolInput = toolInput
      }
      if (text) update.content = tool.output
      events.push(update)
    }
    if (toolCall.status === 'completed' || toolCall.status === 'failed') {
      tool.done = true
      const failed = toolCall.status === 'failed'
      const result = tool.output || boundToolOutput(outputText(toolCall.rawOutput))
      const complete: NormalizedEvent = { type: 'tool_call_complete', index: tool.index, toolId: toolCall.toolCallId, completedAtMs: Date.now(), outcome: { status: failed ? 'failed' : 'completed' } }
      const toolResult: NormalizedEvent = { type: 'tool_result', toolUseId: toolCall.toolCallId, content: result, isError: failed }
      if (tool.parent) {
        complete.parentToolUseId = tool.parent
        toolResult.parentToolUseId = tool.parent
      }
      events.push(complete, toolResult)
    }
    return events
  }
}

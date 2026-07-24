import { z } from 'zod'
import { ClaudeAgent, SAFE_TOOLS, type CanUseTool } from './claude-agent'
import { createSolusMcpServer } from '../../folio/work-tools'
import { createLogger } from '../../logger'
import { isWorkspacePath } from '../../workspace'
import { buildSystemPrompt } from '../system-hint'
import type { CodexDynamicTool } from '../codex/codex-protocol'
import type { NormalizedEvent, ReasoningEffort } from '../../../shared/types'
import { MODEL_PROFILES } from '../../../shared/types'

const log = createLogger('ClaudeSubagent', 'claude-subagent-tool.ts')

export const CLAUDE_SUBAGENT_TOOL_NAME = 'claude_subagent'

const claudeProfiles = MODEL_PROFILES['claude-code'] ?? {}
const DEFAULT_CLAUDE_MODEL =
  Object.entries(claudeProfiles).find(([, profile]) => profile.isDefault)?.[0] ??
  Object.keys(claudeProfiles)[0] ??
  'claude-sonnet-5'

const claudeSubagentInputSchema = z.object({
  prompt: z
    .string()
    .describe(
      'The complete, self-contained task for the Claude subagent. Include all context it needs — it cannot see this conversation.',
    ),
  description: z
    .string()
    .optional()
    .describe('Short (3-8 word) summary of the task, shown on the subagent card.'),
  model: z.string().optional().describe("Claude model id (e.g. 'claude-sonnet-5'). Omit for the default."),
  reasoning_effort: z
    .enum(['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
    .optional()
    .describe("Claude reasoning effort. Defaults to 'high'."),
  read_only: z
    .boolean()
    .optional()
    .describe(
      'Run with write-capable tools denied — the subagent can explore but not modify files. Use for research/review tasks.',
    ),
})

const CLAUDE_SUBAGENT_DESC =
  "Delegate a task to a Claude subagent that runs headlessly in this session's working directory and returns its final answer. Runs unattended (no permission prompts); set read_only for tasks that must not modify files. The result is the subagent's final text — it has no memory between calls."

export const CLAUDE_SUBAGENT_TOOL_SCHEMA: CodexDynamicTool = {
  name: CLAUDE_SUBAGENT_TOOL_NAME,
  description: CLAUDE_SUBAGENT_DESC,
  inputSchema: z.toJSONSchema(claudeSubagentInputSchema) as unknown as CodexDynamicTool['inputSchema'],
}

export interface ClaudeSubagentDeps {
  cwd: string
  /** The parent run's controller — stopping the Codex turn interrupts Claude. */
  abortController: AbortController
  parentToolUseId: string
  /** Plan mode is always read-only, regardless of the tool argument. */
  forceReadOnly?: boolean
  onEvent?: (parentToolUseId: string, event: NormalizedEvent) => void
}

export interface ClaudeSubagentResult {
  ok: boolean
  text: string
}

const READ_ONLY_ALLOWED_TOOLS = SAFE_TOOLS.filter(
  (toolName) => toolName !== 'Agent' && toolName !== 'Task' && toolName !== 'TaskOutput' && toolName !== 'Notebook',
)
const READ_ONLY_ALLOWED_TOOL_SET = new Set(READ_ONLY_ALLOWED_TOOLS)

const readOnlyGate: CanUseTool = async (toolName, input) => {
  if (READ_ONLY_ALLOWED_TOOL_SET.has(toolName)) {
    return { behavior: 'allow', updatedInput: input }
  }
  return {
    behavior: 'deny',
    message: `This Claude subagent is read-only: ${toolName} is not permitted. Use Read, Glob, Grep, or LS instead.`,
  }
}

type ClaudeSubagentTranscriptEvent = Extract<NormalizedEvent, {
  type: 'assistant_message' | 'tool_call' | 'tool_call_update' | 'tool_call_complete' | 'tool_result'
}>

function isTranscriptEvent(event: NormalizedEvent): event is ClaudeSubagentTranscriptEvent {
  return event.type === 'assistant_message' || event.type === 'tool_call' ||
    event.type === 'tool_call_update' || event.type === 'tool_call_complete' ||
    event.type === 'tool_result'
}

/** Run one ephemeral Claude turn for Codex's `claude_subagent` dynamic tool. */
export async function executeClaudeSubagent(
  input: Record<string, unknown>,
  deps: ClaudeSubagentDeps,
): Promise<ClaudeSubagentResult> {
  const parsed = claudeSubagentInputSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, text: `Invalid Claude subagent input: ${z.prettifyError(parsed.error)}` }
  }

  const args = parsed.data
  const readOnly = deps.forceReadOnly === true || args.read_only === true
  const model = args.model && claudeProfiles[args.model] ? args.model : DEFAULT_CLAUDE_MODEL
  const reasoningEffort = (args.reasoning_effort ?? 'high') as ReasoningEffort
  const agent = new ClaudeAgent()

  const solusServer = createSolusMcpServer({
    createCtx: {
      agentProvider: 'claude-code',
      cwd: deps.cwd,
      sessionId: () => undefined,
    },
    includeAutomationTools: false,
  })

  try {
    const { events, result } = agent.run({
      prompt: args.prompt,
      cwd: deps.cwd,
      model,
      reasoningEffort,
      permissionMode: readOnly ? 'ask' : 'auto',
      persistSession: false,
      abortController: deps.abortController,
      systemPromptAppend: buildSystemPrompt({
        agent: 'claude',
        general: isWorkspacePath(deps.cwd),
      }),
      mcpServers: { solus: solusServer },
      allowedTools: readOnly
        ? READ_ONLY_ALLOWED_TOOLS
        : [...SAFE_TOOLS, 'mcp__solus__list_works', 'mcp__solus__search_works', 'mcp__solus__read_work', 'mcp__solus__create_work', 'mcp__solus__render_artifact', 'mcp__solus__create_session', 'mcp__solus__list_sessions', 'mcp__solus__read_session', 'mcp__solus__get_task', 'mcp__solus__list_tasks', 'mcp__solus__list_prs', 'mcp__solus__read_pr', 'mcp__solus__list_pr_threads'],
      canUseTool: readOnly ? readOnlyGate : undefined,
    })

    let finalText = ''
    let runError = ''
    for await (const event of events) {
      if (event.type === 'text_chunk') finalText += event.text
      else if (event.type === 'task_complete' && event.result) finalText = event.result
      else if (event.type === 'error') runError = event.message

      // Claude emits streamed text and then an assembled assistant message.
      // Only forward the assembled form so the nested transcript never doubles.
      if (!isTranscriptEvent(event)) continue
      deps.onEvent?.(deps.parentToolUseId, { ...event, parentToolUseId: deps.parentToolUseId })
    }

    const runResult = await result
    if (runResult.signal === 'SIGINT') return { ok: false, text: 'Claude subagent was interrupted.' }
    if (runError) return { ok: false, text: `Claude subagent failed: ${runError}` }

    log.info(`claude subagent ${runResult.sessionId ?? '(ephemeral)'} finished (${runResult.toolCallCount} tool calls)`)
    return { ok: true, text: finalText || '(Claude subagent returned no text.)' }
  } catch (err: any) {
    log.error(`claude subagent failed: ${String(err)}`)
    return { ok: false, text: `Claude subagent failed: ${String(err?.message ?? err)}` }
  }
}

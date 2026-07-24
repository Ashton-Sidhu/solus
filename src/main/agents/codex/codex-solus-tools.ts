import type { AgentId } from '../../../shared/types'
import {
  WORK_TOOL_JSON_SCHEMAS,
  WORK_TOOL_NAMES,
  WORK_MUTATING_TOOLS,
  executeWorkTool,
  type OnWorkCreated,
  type OnWorkUpdated,
} from '../../folio/work-tools'
import {
  ARTIFACT_TOOL_JSON_SCHEMA,
  ARTIFACT_TOOL_NAME,
  executeArtifactTool,
  type OnArtifact,
} from '../../folio/artifact-tools'
import {
  AUTOMATION_TOOL_JSON_SCHEMAS,
  AUTOMATION_TOOL_NAMES,
  AUTOMATION_MUTATING_TOOLS,
  executeAutomationTool,
  type OnAutomationSaved,
} from '../../automations/automation-tools'
import {
  SESSION_TOOL_JSON_SCHEMAS,
  SESSION_MUTATING_TOOLS,
  SESSION_TOOL_NAMES,
  executeSessionTool,
  type OnSessionCreated,
  type OnSessionPrompted,
  type OnSessionStopped,
} from '../../sessions/session-tools'
import { TASK_TOOL_JSON_SCHEMAS, TASK_TOOL_NAMES, TASK_MUTATING_TOOLS, executeTaskTool, type OnTaskCreated } from '../../tasks/task-tools'
import { PR_TOOL_JSON_SCHEMAS, PR_TOOL_NAMES, PR_MUTATING_TOOLS, executePrTool } from '../../providers/pr-tools'

/**
 * Single source of truth for dispatching Codex dynamicTools (the "solus" tool
 * suite) from a `item/tool/call` server-request. Both the interactive
 * `CodexBackend` and the headless `runCodexOneShot` classify and execute through
 * here so the routing lives in one place; each caller keeps its own concerns
 * (the backend gates mutating tools through the permission UI and emits cards,
 * the headless run auto-runs everything with no UI callbacks).
 */

export type CodexSolusToolKind = 'work' | 'automation' | 'task' | 'session' | 'pr' | 'artifact'

export interface CodexSolusToolClass {
  kind: CodexSolusToolKind
  /** True for tools that write user-visible state and should route through the
   *  permission gate in interactive `ask` mode (create is not counted mutating). */
  mutating: boolean
}

/** Strip any `server.tool` prefix Codex may attach, leaving the bare tool name. */
export function bareToolName(name: string): string {
  return name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name
}

/** Classify a solus dynamic tool by bare name, or null if it isn't one. */
export function classifyCodexSolusTool(name: string): CodexSolusToolClass | null {
  const n = bareToolName(name)
  if (n === ARTIFACT_TOOL_NAME) return { kind: 'artifact', mutating: false }
  if (WORK_TOOL_NAMES.has(n)) return { kind: 'work', mutating: WORK_MUTATING_TOOLS.has(n) }
  if (AUTOMATION_TOOL_NAMES.has(n)) return { kind: 'automation', mutating: AUTOMATION_MUTATING_TOOLS.has(n) }
  if (TASK_TOOL_NAMES.has(n)) return { kind: 'task', mutating: TASK_MUTATING_TOOLS.has(n) }
  if (SESSION_TOOL_NAMES.has(n)) return { kind: 'session', mutating: SESSION_MUTATING_TOOLS.has(n) }
  if (PR_TOOL_NAMES.has(n)) return { kind: 'pr', mutating: PR_MUTATING_TOOLS.has(n) }
  return null
}

/** Origin + side-effect callbacks for a dispatch. Callbacks are optional so a
 *  headless run (no conversation to stream cards into) can omit them. */
export interface CodexSolusToolCtx {
  cwd: string
  sessionId: string | undefined
  agentProvider: AgentId
  onWorkCreated?: OnWorkCreated
  onWorkUpdated?: OnWorkUpdated
  onArtifact?: OnArtifact
  onAutomationSaved?: OnAutomationSaved
  onSessionCreated?: OnSessionCreated
  onSessionPrompted?: OnSessionPrompted
  onSessionStopped?: OnSessionStopped
  onTaskCreated?: OnTaskCreated
}

export interface CodexSolusToolResult {
  ok: boolean
  text: string
}

/**
 * Execute a solus dynamic tool against its shared executor and return a uniform
 * `{ ok, text }`. Permission gating is the caller's responsibility — by the time
 * this runs the call is already approved.
 */
export async function executeCodexSolusTool(
  name: string,
  args: Record<string, unknown>,
  ctx: CodexSolusToolCtx,
): Promise<CodexSolusToolResult> {
  const n = bareToolName(name)
  const cls = classifyCodexSolusTool(n)
  if (!cls) return { ok: false, text: `Unsupported dynamic tool: ${n || '(unnamed)'}` }

  switch (cls.kind) {
    case 'artifact':
      return executeArtifactTool(args, { onArtifact: ctx.onArtifact })
    case 'work':
      return executeWorkTool(n, args, {
        ctx: { sessionId: ctx.sessionId, agentProvider: ctx.agentProvider, cwd: ctx.cwd },
        onWorkCreated: ctx.onWorkCreated,
        onWorkUpdated: ctx.onWorkUpdated,
      })
    case 'automation':
      return executeAutomationTool(n, args, {
        ctx: { agentProvider: ctx.agentProvider, cwd: ctx.cwd, sessionId: ctx.sessionId },
        onAutomationSaved: ctx.onAutomationSaved,
      })
    case 'task':
      return executeTaskTool(n, args, {
        ctx: { cwd: ctx.cwd, sessionId: ctx.sessionId },
        onTaskCreated: ctx.onTaskCreated,
      })
    case 'session':
      return executeSessionTool(n, args, {
        ctx: { agentProvider: ctx.agentProvider, cwd: ctx.cwd, sessionId: ctx.sessionId },
        onSessionCreated: ctx.onSessionCreated,
        onSessionPrompted: ctx.onSessionPrompted,
        onSessionStopped: ctx.onSessionStopped,
      })
    case 'pr':
      return executePrTool(n, args, { ctx: { cwd: ctx.cwd } })
  }
}

/** The dynamicTools schemas to register on thread start. `includeAutomationTools`
 *  is false for headless runs (fork-bomb guard) so an automation run can't create
 *  or trigger more automations. */
export function codexSolusToolSchemas(opts: { includeAutomationTools: boolean }) {
  return [
    ...WORK_TOOL_JSON_SCHEMAS,
    ...(opts.includeAutomationTools ? AUTOMATION_TOOL_JSON_SCHEMAS : []),
    ...SESSION_TOOL_JSON_SCHEMAS,
    ...TASK_TOOL_JSON_SCHEMAS,
    ...PR_TOOL_JSON_SCHEMAS,
    ARTIFACT_TOOL_JSON_SCHEMA,
  ]
}

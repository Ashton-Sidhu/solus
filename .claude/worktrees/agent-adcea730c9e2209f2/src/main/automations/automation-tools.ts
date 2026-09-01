import { z } from 'zod'
import { tool } from '@anthropic-ai/claude-agent-sdk'
import { createLogger } from '../logger'
import type { AgentId, Automation, AutomationAction, AutomationTrigger, ReasoningEffort } from '../../shared/types'
import {
  createAutomation,
  listAutomations,
  loadAutomation,
  updateAutomation,
  deleteAutomation,
  listRuns,
  loadRun,
} from './automations-store'
import { validateTrigger } from './automation-schedule'
import { hasActiveRun, triggerAutomationRun } from './automation-runner'

const log = createLogger('automations', 'automation-tools.ts')

/**
 * Single source of truth for the agent-facing automation tools (full CRUD plus
 * run-now and run-result access). Like work-tools.ts it exports three shapes
 * from one set of zod schemas: Claude SDK `tool()` objects, Codex JSON-schema
 * descriptors, and a shared executor used by both. Tools return error TEXT
 * (never throw) so a bad call degrades to a message the agent can recover from.
 *
 * Phase 1: run-now only (no scheduling, no templating). The run executes on the
 * automation's own agent (Claude or Codex) with 'auto' permissions, and gets no
 * automation tools (fork-bomb guard, see runner).
 */

const REASONING_VALUES = ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'] as const
// Providers that can execute a headless run (Phase 1). 'opencode' is excluded —
// it has no one-shot runner yet.
const AGENT_PROVIDER_VALUES = ['claude-code', 'codex'] as const

// ─── Schemas (raw zod shapes, reused by every shape we export) ───

const listAutomationsShape = {} as const

const idShape = {
  automation_id: z.string().describe('The id of the automation (from list_automations).'),
}

// One flat trigger object covering every time-based trigger. Only the fields
// relevant to `type` are read (see toTrigger); the rest are ignored.
const triggerSchema = z
  .object({
    type: z.enum(['manual', 'once', 'interval', 'cron']).describe('When the automation runs.'),
    run_at: z.string().optional().describe('type "once": ISO-8601 instant to run at, e.g. "2026-07-01T09:00:00Z".'),
    every_minutes: z.number().int().positive().optional().describe('type "interval": minutes between runs.'),
    cron: z.string().optional().describe('type "cron": a 5-field cron expression, e.g. "0 9 * * 1-5".'),
    timezone: z.string().optional().describe('type "cron": IANA timezone, e.g. "America/Toronto". Defaults to the system timezone.'),
  })
  .describe('Trigger for the automation. Omit for a manual (run-now-only) automation. Scheduled triggers fire only while Solus is open.')

const createAutomationShape = {
  name: z.string().describe('A short, human-readable name for the automation.'),
  prompt: z.string().describe('The instruction submitted to the agent when the automation runs.'),
  cwd: z.string().optional().describe('Working directory the run executes in. Defaults to the active project directory (the path shown in the status bar).'),
  agent_provider: z.enum(AGENT_PROVIDER_VALUES).optional().describe("Which agent runs the automation: 'claude-code' (default) or 'codex'."),
  model_id: z.string().nullable().optional().describe('Model id to run with. Omit or null for the default model.'),
  reasoning_effort: z.enum(REASONING_VALUES).optional().describe("Reasoning effort for runs. Defaults to 'medium'."),
  enabled: z.boolean().optional().describe('Whether the automation is enabled. Defaults to true.'),
  run_in_session: z
    .boolean()
    .optional()
    .describe(
      'When true, the automation runs *inside the current chat thread* — each run resumes this conversation with full context and posts its prompt as an in-thread message badged "Sent via automation", rather than as an isolated background task. Use this when the user wants a recurring check "in this chat" (e.g. "check every minute for new github issues"). Requires a scheduled trigger.',
    ),
  trigger: triggerSchema.optional(),
}

const updateAutomationShape = {
  automation_id: z.string().describe('The id of the automation to update.'),
  name: z.string().optional(),
  prompt: z.string().optional(),
  cwd: z.string().optional(),
  agent_provider: z.enum(AGENT_PROVIDER_VALUES).optional(),
  model_id: z.string().nullable().optional(),
  reasoning_effort: z.enum(REASONING_VALUES).optional(),
  enabled: z.boolean().optional(),
  run_in_session: z
    .boolean()
    .optional()
    .describe('true binds the automation to the current chat thread (runs in-thread with full context); false unbinds it back to an isolated background run.'),
  trigger: triggerSchema.optional(),
}

const setEnabledShape = {
  automation_id: z.string().describe('The id of the automation.'),
  enabled: z.boolean().describe('true to resume, false to pause.'),
}

const readRunShape = {
  automation_id: z.string().describe('The id of the automation.'),
  run_id: z.string().describe('The id of the run (from list_automation_runs).'),
}

// ─── Descriptions ───

const CREATE_DESC =
  'Create a new automation: a saved prompt run against an agent with a frozen agent, model, and reasoning level. Runs execute unattended with auto-approved permissions. Provide a `trigger` to schedule it (one-time, interval, or cron) — scheduled runs fire only while Solus is open and catch up a missed fire on the next launch. Omit `trigger` for a manual automation you start with run_automation. Set `run_in_session: true` to run it inside the current chat thread with full conversation context (each run posts its prompt in-thread, badged "Sent via automation"); omit it for an isolated background run. Returns the new automation id.'
const LIST_DESC =
  'List all automations with their id, name, enabled state, and last run status. Call this to discover an automation_id.'
const READ_DESC = 'Read the full definition of one automation by id.'
const UPDATE_DESC = 'Update fields of an existing automation (any subset). Unspecified fields are left unchanged.'
const DELETE_DESC = 'Permanently delete an automation and its run history.'
const SET_ENABLED_DESC = 'Pause or resume an automation without changing its other settings.'
const RUN_DESC =
  'Trigger an automation to run now. Returns a run_id immediately; the run executes in the background. Poll read_automation_run with the run_id to get the result.'
const LIST_RUNS_DESC = 'List the run history of an automation (newest first), with status and timing.'
const READ_RUN_DESC =
  'Read the full result of a single automation run: status, the agent output, the spawned session id, and any error.'

// ─── Helpers ───

function reasoning(value: unknown, fallback: ReasoningEffort): ReasoningEffort {
  return (REASONING_VALUES as readonly string[]).includes(String(value)) ? (value as ReasoningEffort) : fallback
}

function agentProvider(value: unknown, fallback: AgentId): AgentId {
  return (AGENT_PROVIDER_VALUES as readonly string[]).includes(String(value)) ? (value as AgentId) : fallback
}

/** Map the flat tool trigger object to an AutomationTrigger. Returns a string
 *  error message if the shape is malformed, or the trigger if valid. */
function toTrigger(raw: unknown): AutomationTrigger | string {
  if (raw === undefined || raw === null) return { type: 'manual' }
  if (typeof raw !== 'object') return 'trigger must be an object.'
  const t = raw as Record<string, unknown>
  let trigger: AutomationTrigger
  switch (t.type) {
    case 'manual':
      trigger = { type: 'manual' }
      break
    case 'once':
      if (typeof t.run_at !== 'string') return 'trigger type "once" requires run_at (an ISO-8601 instant).'
      trigger = { type: 'once', runAt: t.run_at }
      break
    case 'interval':
      if (typeof t.every_minutes !== 'number') return 'trigger type "interval" requires every_minutes.'
      trigger = { type: 'interval', everyMinutes: t.every_minutes }
      break
    case 'cron':
      if (typeof t.cron !== 'string') return 'trigger type "cron" requires a cron expression.'
      trigger = { type: 'cron', expr: t.cron, ...(typeof t.timezone === 'string' ? { timezone: t.timezone } : {}) }
      break
    default:
      return `Unknown trigger type "${String(t.type)}".`
  }
  const err = validateTrigger(trigger)
  return err ?? trigger
}

function describeRun(r: {
  id: string
  status: string
  startedAt: string
  finishedAt?: string
  agentSessionId?: string | null
  output?: string
  error?: string
}): string {
  const lines = [
    `run_id: ${r.id}`,
    `status: ${r.status}`,
    `started: ${r.startedAt}`,
    ...(r.finishedAt ? [`finished: ${r.finishedAt}`] : []),
    ...(r.agentSessionId ? [`session_id: ${r.agentSessionId}`] : []),
  ]
  if (r.error) lines.push(`error: ${r.error}`)
  if (r.output) lines.push('', 'output:', r.output)
  return lines.join('\n')
}

// ─── Executor (shared by Claude SDK tools + Codex handler) ───

export interface AutomationToolCtx {
  agentProvider: AgentId
  cwd: string
  sessionId: string | undefined
}

/** Fired when create_automation/update_automation persists, so the calling
 *  chat thread can render an automation card (see claude/codex backends). */
export type OnAutomationSaved = (automation: Automation) => void

export interface AutomationToolDeps {
  ctx?: AutomationToolCtx
  onAutomationSaved?: OnAutomationSaved
}

export interface AutomationToolResult {
  ok: boolean
  text: string
}

export async function executeAutomationTool(
  name: string,
  args: Record<string, unknown>,
  deps: AutomationToolDeps = {},
): Promise<AutomationToolResult> {
  try {
    if (name === 'list_automations') {
      const automations = await listAutomations()
      if (automations.length === 0) return { ok: true, text: 'No automations exist yet.' }
      const lines = automations.map(
        (a) => `- ${a.id} — "${a.name}" (${a.enabled ? 'enabled' : 'paused'})${a.lastRunStatus ? `, last run: ${a.lastRunStatus}` : ''}`,
      )
      return { ok: true, text: `Automations:\n${lines.join('\n')}` }
    }

    if (name === 'read_automation') {
      const id = String(args.automation_id ?? '')
      if (!id) return { ok: false, text: 'read_automation requires an automation_id.' }
      const a = await loadAutomation(id)
      if (!a) return { ok: false, text: `No automation found with id "${id}".` }
      return { ok: true, text: JSON.stringify(a, null, 2) }
    }

    if (name === 'create_automation') {
      const name_ = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : ''
      const prompt = typeof args.prompt === 'string' ? args.prompt : ''
      if (!name_) return { ok: false, text: 'create_automation requires a name.' }
      if (!prompt.trim()) return { ok: false, text: 'create_automation requires a non-empty prompt.' }

      // No cwd given → run in the active project directory (the status-bar path,
      // which is the calling session's working directory).
      const cwd = typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd : (deps.ctx?.cwd ?? '~')
      // Bind to the calling chat thread when asked to run in-session. Without a
      // caller session id (e.g. a headless call) there's no thread to run inside,
      // so fall back to a normal background run rather than failing.
      if (args.run_in_session === true && !deps.ctx?.sessionId) {
        return { ok: false, text: 'create_automation: run_in_session requires being called from within a chat session.' }
      }
      const action: AutomationAction = {
        prompt,
        // The run executes on the automation's chosen agent — defaults to the
        // caller's provider so "automate what I just did" runs on the same agent,
        // falling back to claude-code if the caller isn't a runnable provider.
        agentProvider: agentProvider(args.agent_provider ?? deps.ctx?.agentProvider, 'claude-code'),
        modelId: typeof args.model_id === 'string' ? args.model_id : null,
        reasoningEffort: reasoning(args.reasoning_effort, 'medium'),
        cwd,
        ...(args.run_in_session === true ? { sessionId: deps.ctx!.sessionId } : {}),
      }
      const enabled = typeof args.enabled === 'boolean' ? args.enabled : true
      const trigger = toTrigger(args.trigger)
      if (typeof trigger === 'string') return { ok: false, text: `create_automation: ${trigger}` }
      const created = await createAutomation(name_, action, {
        kind: 'agent',
        agentProvider: deps.ctx?.agentProvider,
        sessionId: deps.ctx?.sessionId,
      }, enabled, trigger)
      const when =
        created.trigger.type === 'manual'
          ? 'Trigger it with run_automation.'
          : `Scheduled (${created.trigger.type})${created.nextRunAt ? `; next run ${created.nextRunAt}` : ''}.`
      const where = created.action.sessionId ? ' Runs in this chat thread with full context.' : ''
      deps.onAutomationSaved?.(created)
      return { ok: true, text: `Created automation "${created.name}" (id: ${created.id}). ${when}${where}` }
    }

    if (name === 'update_automation') {
      const id = String(args.automation_id ?? '')
      if (!id) return { ok: false, text: 'update_automation requires an automation_id.' }
      const existing = await loadAutomation(id)
      if (!existing) return { ok: false, text: `No automation found with id "${id}".` }

      const actionPatch: Partial<AutomationAction> = {}
      if (typeof args.prompt === 'string') actionPatch.prompt = args.prompt
      if (typeof args.cwd === 'string') actionPatch.cwd = args.cwd
      if (args.agent_provider !== undefined) actionPatch.agentProvider = agentProvider(args.agent_provider, existing.action.agentProvider)
      if (args.model_id === null || typeof args.model_id === 'string') actionPatch.modelId = args.model_id as string | null
      // Switching provider without naming a model resets to that provider's
      // default — the old provider's model id would be meaningless on the new one.
      else if (actionPatch.agentProvider && actionPatch.agentProvider !== existing.action.agentProvider) actionPatch.modelId = null
      if (args.reasoning_effort !== undefined) actionPatch.reasoningEffort = reasoning(args.reasoning_effort, existing.action.reasoningEffort)
      if (args.run_in_session === true) {
        if (!deps.ctx?.sessionId) return { ok: false, text: 'update_automation: run_in_session requires being called from within a chat session.' }
        actionPatch.sessionId = deps.ctx.sessionId
      } else if (args.run_in_session === false) {
        actionPatch.sessionId = undefined
      }

      let triggerPatch: AutomationTrigger | undefined
      if (args.trigger !== undefined) {
        const t = toTrigger(args.trigger)
        if (typeof t === 'string') return { ok: false, text: `update_automation: ${t}` }
        triggerPatch = t
      }

      const updated = await updateAutomation(id, {
        ...(typeof args.name === 'string' ? { name: args.name } : {}),
        ...(typeof args.enabled === 'boolean' ? { enabled: args.enabled } : {}),
        ...(Object.keys(actionPatch).length ? { action: actionPatch } : {}),
        ...(triggerPatch ? { trigger: triggerPatch } : {}),
      })
      if (updated) deps.onAutomationSaved?.(updated)
      return { ok: true, text: `Updated automation "${updated?.name}".` }
    }

    if (name === 'delete_automation') {
      const id = String(args.automation_id ?? '')
      if (!id) return { ok: false, text: 'delete_automation requires an automation_id.' }
      const ok = await deleteAutomation(id)
      return ok
        ? { ok: true, text: `Deleted automation ${id}.` }
        : { ok: false, text: `No automation found with id "${id}".` }
    }

    if (name === 'set_automation_enabled') {
      const id = String(args.automation_id ?? '')
      if (!id) return { ok: false, text: 'set_automation_enabled requires an automation_id.' }
      if (typeof args.enabled !== 'boolean') return { ok: false, text: 'set_automation_enabled requires a boolean "enabled".' }
      const updated = await updateAutomation(id, { enabled: args.enabled })
      if (!updated) return { ok: false, text: `No automation found with id "${id}".` }
      return { ok: true, text: `Automation "${updated.name}" is now ${updated.enabled ? 'enabled' : 'paused'}.` }
    }

    if (name === 'run_automation') {
      const id = String(args.automation_id ?? '')
      if (!id) return { ok: false, text: 'run_automation requires an automation_id.' }
      const a = await loadAutomation(id)
      if (!a) return { ok: false, text: `No automation found with id "${id}".` }
      if (!a.enabled) return { ok: false, text: `Automation "${a.name}" is paused. Enable it before running.` }
      if (hasActiveRun(a.id)) return { ok: false, text: `Automation "${a.name}" already has a run in progress. Wait for it to finish (list_automation_runs shows its status) or cancel it first.` }
      const run = await triggerAutomationRun(a)
      return { ok: true, text: `Started run ${run.id} for "${a.name}". It runs in the background — read_automation_run with run_id "${run.id}" to get the result.` }
    }

    if (name === 'list_automation_runs') {
      const id = String(args.automation_id ?? '')
      if (!id) return { ok: false, text: 'list_automation_runs requires an automation_id.' }
      const runs = await listRuns(id)
      if (runs.length === 0) return { ok: true, text: 'This automation has no runs yet.' }
      const lines = runs.map(
        (r) => `- ${r.id} — ${r.status}, started ${r.startedAt}${r.finishedAt ? `, finished ${r.finishedAt}` : ''}`,
      )
      return { ok: true, text: `Runs (newest first):\n${lines.join('\n')}` }
    }

    if (name === 'read_automation_run') {
      const id = String(args.automation_id ?? '')
      const runId = String(args.run_id ?? '')
      if (!id || !runId) return { ok: false, text: 'read_automation_run requires automation_id and run_id.' }
      const run = await loadRun(id, runId)
      if (!run) return { ok: false, text: `No run "${runId}" found for automation "${id}".` }
      return { ok: true, text: describeRun(run) }
    }

    return { ok: false, text: `Unknown automation tool: ${name}` }
  } catch (err: any) {
    log.error(`executeAutomationTool(${name}) failed: ${String(err)}`)
    return { ok: false, text: `Automation tool error: ${String(err?.message ?? err)}` }
  }
}

// ─── Shape 1: Claude SDK tools (composed into the `solus` MCP server) ───

function toToolResult(r: AutomationToolResult) {
  return {
    content: [{ type: 'text' as const, text: r.text }],
    ...(r.ok ? {} : { isError: true as const }),
  }
}

/** Origin context for tool calls, resolved lazily (sessionId lands after init). */
export interface AutomationSdkDeps {
  agentProvider: AgentId
  cwd: string
  sessionId: () => string | undefined
  onAutomationSaved?: OnAutomationSaved
}

export function automationSdkTools(deps: AutomationSdkDeps) {
  const mk = (): AutomationToolDeps => ({
    ctx: { agentProvider: deps.agentProvider, cwd: deps.cwd, sessionId: deps.sessionId() },
    onAutomationSaved: deps.onAutomationSaved,
  })
  const run = (n: string) => async (args: unknown) =>
    toToolResult(await executeAutomationTool(n, (args ?? {}) as Record<string, unknown>, mk()))
  return [
    tool('create_automation', CREATE_DESC, createAutomationShape, run('create_automation')),
    tool('list_automations', LIST_DESC, listAutomationsShape, run('list_automations')),
    tool('read_automation', READ_DESC, idShape, run('read_automation')),
    tool('update_automation', UPDATE_DESC, updateAutomationShape, run('update_automation')),
    tool('delete_automation', DELETE_DESC, idShape, run('delete_automation')),
    tool('set_automation_enabled', SET_ENABLED_DESC, setEnabledShape, run('set_automation_enabled')),
    tool('run_automation', RUN_DESC, idShape, run('run_automation')),
    tool('list_automation_runs', LIST_RUNS_DESC, idShape, run('list_automation_runs')),
    tool('read_automation_run', READ_RUN_DESC, readRunShape, run('read_automation_run')),
  ]
}

// ─── Shape 2: Codex dynamicTools JSON-schema descriptors ───

export interface AutomationToolDescriptor {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export const AUTOMATION_TOOL_JSON_SCHEMAS: AutomationToolDescriptor[] = [
  { name: 'create_automation', description: CREATE_DESC, inputSchema: z.toJSONSchema(z.object(createAutomationShape)) as Record<string, unknown> },
  { name: 'list_automations', description: LIST_DESC, inputSchema: z.toJSONSchema(z.object(listAutomationsShape)) as Record<string, unknown> },
  { name: 'read_automation', description: READ_DESC, inputSchema: z.toJSONSchema(z.object(idShape)) as Record<string, unknown> },
  { name: 'update_automation', description: UPDATE_DESC, inputSchema: z.toJSONSchema(z.object(updateAutomationShape)) as Record<string, unknown> },
  { name: 'delete_automation', description: DELETE_DESC, inputSchema: z.toJSONSchema(z.object(idShape)) as Record<string, unknown> },
  { name: 'set_automation_enabled', description: SET_ENABLED_DESC, inputSchema: z.toJSONSchema(z.object(setEnabledShape)) as Record<string, unknown> },
  { name: 'run_automation', description: RUN_DESC, inputSchema: z.toJSONSchema(z.object(idShape)) as Record<string, unknown> },
  { name: 'list_automation_runs', description: LIST_RUNS_DESC, inputSchema: z.toJSONSchema(z.object(idShape)) as Record<string, unknown> },
  { name: 'read_automation_run', description: READ_RUN_DESC, inputSchema: z.toJSONSchema(z.object(readRunShape)) as Record<string, unknown> },
]

export const AUTOMATION_TOOL_NAMES = new Set(AUTOMATION_TOOL_JSON_SCHEMAS.map((t) => t.name))

/** Tools that mutate or trigger — these route through permissions on Codex.
 *  Read-only tools (list/read) are pre-approved. */
export const AUTOMATION_MUTATING_TOOLS = new Set([
  'create_automation',
  'update_automation',
  'delete_automation',
  'set_automation_enabled',
  'run_automation',
])

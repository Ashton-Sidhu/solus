import { z } from 'zod'
import { createLogger } from '../logger'
import type { AgentTool } from '../agents/tools/agent-tool'
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
import { Task } from '../tasks/task'
import { foreignTaskLinksFor } from '../tasks/foreign-tasks'

const log = createLogger('automations', 'automation-tools.ts')

/**
 * Provider-neutral automation tools for full CRUD plus run-now and run-result
 * access. Tools return error text
 * (never throw) so a bad call degrades to a message the agent can recover from.
 *
 * Phase 1: run-now only (no scheduling, no templating). The run executes on the
 * automation's own agent (Claude or Codex) with 'auto' permissions, and gets no
 * automation tools (fork-bomb guard, see runner).
 */

const REASONING_VALUES = ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode'] as const
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

interface AutomationToolArgs {
  automation_id?: string
  run_id?: string
  name?: string
  prompt?: string
  cwd?: string
  agent_provider?: AgentId
  model_id?: string | null
  reasoning_effort?: ReasoningEffort
  enabled?: boolean
  run_in_session?: boolean
  trigger?: z.infer<typeof triggerSchema>
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
  const t = raw as {
    type?: unknown
    run_at?: unknown
    every_minutes?: unknown
    cron?: unknown
    timezone?: unknown
  }
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
  /** Solus session id — keys a dispatched session's shipped task snapshot,
   *  whose automation links answer for rows that live on the task's host. */
  solusSessionId?: string
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

/** The task-snapshot link for an automation id the local store cannot resolve
 *  — present exactly when this session was dispatched and its task links one. */
function foreignAutomationLink(solusSessionId: string | undefined, automationId: string) {
  return foreignTaskLinksFor(solusSessionId).find(
    (link) => link.kind === 'automation' && link.targetKey === automationId,
  ) ?? null
}

/** The honest answer for a write against an automation that lives elsewhere. */
function foreignAutomationError(operation: string, automationId: string): string {
  return `Automation ${automationId} lives on the task's host (this session was dispatched), and ${operation} cannot reach it from here. Manage it from the task's host, or note the request in a comment_task.`
}

export async function executeAutomationTool(
  name: string,
  args: AutomationToolArgs,
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
      if (!a) {
        // A dispatched session's task may link an automation whose row lives
        // on the task's host; the link's snapshot facts are all this host has.
        const link = foreignAutomationLink(deps.ctx?.solusSessionId, id)
        if (link) {
          return {
            ok: true,
            text: `Automation ${id} — "${link.liveTitle ?? link.title}"${link.liveStatus ? ` [${link.liveStatus}]` : ''}. It lives on the task's host (this session was dispatched); only these linked facts are readable here, and it cannot be edited or run from this host.`,
          }
        }
        return { ok: false, text: `No automation found with id "${id}".` }
      }
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
      if (deps.ctx?.sessionId) {
        await Task.linkArtifactForSession(deps.ctx.sessionId, {
          kind: 'automation',
          targetKey: created.id,
          title: created.name,
        }).catch((error) => {
          log.warn('task_automation_link_failed', {
            sessionId: deps.ctx?.sessionId,
            automationId: created.id,
            error: error instanceof Error ? error.message : String(error),
          })
        })
      }
      deps.onAutomationSaved?.(created)
      return { ok: true, text: `Created automation "${created.name}" (id: ${created.id}). ${when}${where}` }
    }

    if (name === 'update_automation') {
      const id = String(args.automation_id ?? '')
      if (!id) return { ok: false, text: 'update_automation requires an automation_id.' }
      const existing = await loadAutomation(id)
      if (!existing) {
        if (foreignAutomationLink(deps.ctx?.solusSessionId, id)) {
          return { ok: false, text: foreignAutomationError('update_automation', id) }
        }
        return { ok: false, text: `No automation found with id "${id}".` }
      }

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
      if (updated && deps.ctx?.sessionId) {
        await Task.linkArtifactForSession(deps.ctx.sessionId, {
          kind: 'automation',
          targetKey: updated.id,
          title: updated.name,
        }).catch((error) => {
          log.warn('task_automation_link_failed', {
            sessionId: deps.ctx?.sessionId,
            automationId: updated.id,
            error: error instanceof Error ? error.message : String(error),
          })
        })
      }
      if (updated) deps.onAutomationSaved?.(updated)
      return { ok: true, text: `Updated automation "${updated?.name}".` }
    }

    if (name === 'delete_automation') {
      const id = String(args.automation_id ?? '')
      if (!id) return { ok: false, text: 'delete_automation requires an automation_id.' }
      if (foreignAutomationLink(deps.ctx?.solusSessionId, id)) {
        return { ok: false, text: foreignAutomationError('delete_automation', id) }
      }
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
      if (!updated) {
        if (foreignAutomationLink(deps.ctx?.solusSessionId, id)) {
          return { ok: false, text: foreignAutomationError('set_automation_enabled', id) }
        }
        return { ok: false, text: `No automation found with id "${id}".` }
      }
      return { ok: true, text: `Automation "${updated.name}" is now ${updated.enabled ? 'enabled' : 'paused'}.` }
    }

    if (name === 'run_automation') {
      const id = String(args.automation_id ?? '')
      if (!id) return { ok: false, text: 'run_automation requires an automation_id.' }
      const a = await loadAutomation(id)
      if (!a) {
        if (foreignAutomationLink(deps.ctx?.solusSessionId, id)) {
          return { ok: false, text: foreignAutomationError('run_automation', id) }
        }
        return { ok: false, text: `No automation found with id "${id}".` }
      }
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
    log.error('automation_tool_failed', { tool: name, error: err instanceof Error ? err.message : String(err) })
    return { ok: false, text: `Automation tool error: ${String(err?.message ?? err)}` }
  }
}

function automationAgentTool(
  name: string,
  description: string,
  inputShape: z.ZodRawShape,
  requiresApproval: boolean,
): AgentTool {
  return {
    name,
    description,
    inputShape,
    requiresApproval,
    execute: async (args, context) => executeAutomationTool(name, args, {
      ctx: {
        agentProvider: context.provider,
        cwd: context.cwd,
        sessionId: context.sessionId(),
        solusSessionId: context.solusSessionId(),
      },
      onAutomationSaved: (automation) => context.emit({
        type: 'automation_saved',
        automationId: automation.id,
        name: automation.name,
        trigger: automation.trigger,
        enabled: automation.enabled,
      }),
    }),
  }
}

export const createAutomationAgentTool = automationAgentTool('create_automation', CREATE_DESC, createAutomationShape, true)
export const listAutomationsAgentTool = automationAgentTool('list_automations', LIST_DESC, listAutomationsShape, false)
export const readAutomationAgentTool = automationAgentTool('read_automation', READ_DESC, idShape, false)
export const updateAutomationAgentTool = automationAgentTool('update_automation', UPDATE_DESC, updateAutomationShape, true)
export const deleteAutomationAgentTool = automationAgentTool('delete_automation', DELETE_DESC, idShape, true)
export const setAutomationEnabledAgentTool = automationAgentTool('set_automation_enabled', SET_ENABLED_DESC, setEnabledShape, true)
export const runAutomationAgentTool = automationAgentTool('run_automation', RUN_DESC, idShape, true)
export const listAutomationRunsAgentTool = automationAgentTool('list_automation_runs', LIST_RUNS_DESC, idShape, false)
export const readAutomationRunAgentTool = automationAgentTool('read_automation_run', READ_RUN_DESC, readRunShape, false)

export const automationAgentTools: AgentTool[] = [
  createAutomationAgentTool,
  listAutomationsAgentTool,
  readAutomationAgentTool,
  updateAutomationAgentTool,
  deleteAutomationAgentTool,
  setAutomationEnabledAgentTool,
  runAutomationAgentTool,
  listAutomationRunsAgentTool,
  readAutomationRunAgentTool,
]

import { enforce, hostPolicies } from '../../../host/policy/host-policy-store'
import { LOCAL_ORGANIZATION_ID } from '../../../host/machine-kind'
import { organizationOfSession } from '../../../data/sessions/session-records'
import { z } from 'zod'
import { sessionSettings } from '../../sessions/session-settings'
import { createLogger } from '../../../logger'
import type { AgentTool } from './agent-tool'
import { toolAgentAttribution } from './agent-attribution'
import type { AgentId, Automation, AutomationAction, AutomationTrigger, ReasoningEffort } from '@solus/contracts/types'
import {
  automationHomeOf,
  createAutomation,
  listAutomations,
  loadAutomation,
  updateAutomation,
  deleteAutomation,
  listRuns,
  loadRun,
} from '../../../data/automations/automations-store'
import { roleAllows, type ResourceVerb } from '@solus/contracts/permissions'
import { roleOf } from '../../../admission/access'
import { actorFor, type Actor } from '../../../admission/actor'
import { ANY_ORGANIZATION, INTERNAL_PRINCIPAL } from '../../../admission/principal'
import { workspaceToolAuthority } from '../../../admission/workspace-tool-authority'
import { scheduleHasEnded, validateTrigger } from '../../../data/automations/automation-schedule'
import { hasActiveRun, triggerAutomationRun } from '../../automations/automation-runner'
import { linkSessionOutput } from '../../../data/tasks/task-attachments'
import { foreignTaskLinksFor } from '../../../data/tasks/foreign-tasks'
import { resolveAutomationCwd } from '../../automations/automation-cwd'

const log = createLogger('automations', 'automation-tools.ts')

/**
 * Provider-neutral automation tools for full CRUD plus run-now and run-result
 * access. Tools return error text so the agent can recover from a failed call.
 * PromptDispatch selects which tools each kind of session receives.
 */

const REASONING_VALUES = ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode'] as const
// Providers that can execute a headless run (Phase 1). 'opencode' is excluded —
// it has no one-shot runner yet.
const AGENT_PROVIDER_VALUES = ['claude-code', 'codex'] as const

// ─── Schemas (raw Zod fields, reused by every tool definition) ───

// One flat trigger object covering every time-based trigger. Only the fields
// relevant to `type` are read (see toTrigger); the rest are ignored.
const triggerSchema = z
  .object({
    type: z.enum(['manual', 'once', 'interval', 'cron']).describe('When the automation runs.'),
    run_at: z.string().optional().describe('type "once": ISO-8601 instant to run at, e.g. "2026-07-01T09:00:00Z".'),
    every_minutes: z.number().int().positive().optional().describe('type "interval": minutes between runs.'),
    cron: z.string().optional().describe('type "cron": a 5-field cron expression, e.g. "0 9 * * 1-5".'),
    timezone: z.string().optional().describe('type "cron": IANA timezone, e.g. "America/Toronto". Defaults to the system timezone.'),
    ends_at: z.string().optional().describe('type "interval" or "cron": ISO-8601 instant. No scheduled run starts at or after it.'),
  })
  .describe('Trigger for the automation. Omit for a manual (run-now-only) automation. Scheduled triggers fire only while Solus is open.')

const READ_ACTIONS = ['list', 'read', 'runs'] as const
const MANAGE_ACTIONS = ['create', 'update', 'delete', 'run'] as const
export type AutomationToolAction = (typeof READ_ACTIONS)[number] | (typeof MANAGE_ACTIONS)[number]

const readFields = {
  action: z.enum(READ_ACTIONS),
  automation_id: z.string().optional().describe('read and runs: required.'),
  run_id: z.string().optional().describe('runs: only this run.'),
}

/** The fields of manage_automations, with its action limited to `actions`. */
function manageFields(actions: readonly [AutomationToolAction, ...AutomationToolAction[]]) {
  return {
    action: z.enum(actions),
    automation_id: z.string().optional().describe('Required, except for create.'),
    name: z.string().optional().describe('create: required. A short, human-readable name.'),
    prompt: z.string().optional().describe('create: required. The instruction the agent gets at each run.'),
    cwd: z.string().optional().describe('Exact working directory for the run. create: defaults to the active project root.'),
    use_worktree: z.boolean().optional().describe('True: each run makes an isolated worktree from cwd. Defaults to false.'),
    agent_provider: z.enum(AGENT_PROVIDER_VALUES).optional().describe("Which agent runs it: 'claude-code' (default) or 'codex'."),
    model_id: z.string().nullable().optional().describe('Omit or null for the default model.'),
    reasoning_effort: z.enum(REASONING_VALUES).optional().describe("Defaults to 'medium'."),
    enabled: z.boolean().optional().describe('Defaults to true.'),
    archived: z.boolean().optional().describe('update: true stops future checks and keeps history until the host retention period expires. False restores it as paused.'),
    trigger: triggerSchema.optional(),
  }
}

interface AutomationToolArgs {
  archived?: boolean
  automation_id?: string
  run_id?: string
  name?: string
  prompt?: string
  cwd?: string
  use_worktree?: boolean
  agent_provider?: AgentId
  model_id?: string | null
  reasoning_effort?: ReasoningEffort
  enabled?: boolean
  trigger?: z.infer<typeof triggerSchema>
}

// ─── Descriptions ───

const MANAGE_DESC =
  'Change automations — the way recurring, scheduled, and "remind me to…" work that runs in its own session is set up in Solus. create: a saved prompt with a frozen agent, model, and reasoning level; returns the new automation id. Runs execute unattended with auto-approved permissions. To wait for a result and then continue in this conversation ("tell me when CI finishes", "watch CI and fix failures"), run the wait as a background command instead; its result wakes this conversation. Interpret “in 30 minutes” as a once trigger and “every 30 minutes” as an interval trigger. Creating a scheduled automation is sufficient: do not also run it unless the user asked for an immediate check. An explicit `cwd` is used unchanged. Set `use_worktree: true` only when each run must create an isolated worktree from that cwd. Provide a `trigger` to schedule it (one-time, interval, or cron); scheduled runs fire only while Solus is open and catch up a missed fire on the next launch. update: any subset; unspecified fields stay. Pause or resume with enabled alone; archive with archived: true. A check already queued or running can still finish. delete: the automation and its run history, permanently. run: start it now; returns a run_id at once, and the run continues in the background. Use read_automations runs for its status and session_id, then read_session for agent output.'
const READ_DESC =
  'Read automations. list: every automation with its id, name, state, and last run status. read: the full definition of one. runs: its runs newest first, with status, timing, session_id, and errors, including failures before a session starts. Use read_session with a session_id for agent output.'

// ─── Helpers ───

function reasoning(value: ReasoningEffort | undefined, fallback: ReasoningEffort): ReasoningEffort {
  return value && REASONING_VALUES.some((candidate) => candidate === value) ? value : fallback
}

function agentProvider(value: AgentId | undefined, fallback: AgentId): AgentId {
  return value && AGENT_PROVIDER_VALUES.some((candidate) => candidate === value) ? value : fallback
}

type TriggerResult =
  | { ok: true; trigger: AutomationTrigger }
  | { ok: false; error: string }

/** Map the parsed tool trigger fields to the stored automation trigger. */
function toTrigger(raw: AutomationToolArgs['trigger']): TriggerResult {
  if (!raw) return { ok: true, trigger: { type: 'manual' } }
  let trigger: AutomationTrigger
  switch (raw.type) {
    case 'manual':
      trigger = { type: 'manual' }
      break
    case 'once':
      if (!raw.run_at) return { ok: false, error: 'trigger type "once" requires run_at (an ISO-8601 instant).' }
      trigger = { type: 'once', runAt: raw.run_at }
      break
    case 'interval':
      if (!raw.every_minutes) return { ok: false, error: 'trigger type "interval" requires every_minutes.' }
      trigger = { type: 'interval', everyMinutes: raw.every_minutes }
      if (raw.ends_at) trigger.endsAt = raw.ends_at
      break
    case 'cron':
      if (!raw.cron) return { ok: false, error: 'trigger type "cron" requires a cron expression.' }
      trigger = { type: 'cron', expr: raw.cron }
      if (raw.timezone) trigger.timezone = raw.timezone
      if (raw.ends_at) trigger.endsAt = raw.ends_at
      break
    default:
      return { ok: false, error: `Unknown trigger type "${String(raw.type)}".` }
  }
  const err = validateTrigger(trigger)
  if (err) return { ok: false, error: err }
  if (scheduleHasEnded(trigger, new Date())) return { ok: false, error: 'ends_at must be in the future.' }
  return { ok: true, trigger }
}

function describeRun(r: {
  id: string
  status: string
  startedAt: string
  finishedAt?: string
  sessionId?: string | null
  error?: string
}): string {
  const lines = [
    `run_id: ${r.id}`,
    `status: ${r.status}`,
    `started: ${r.startedAt}`,
    ...(r.finishedAt ? [`finished: ${r.finishedAt}`] : []),
    ...(r.sessionId ? [`session_id: ${r.sessionId}`] : []),
  ]
  if (r.error) lines.push(`error: ${r.error}`)
  return lines.join('\n')
}

// ─── Executor (shared by Claude SDK tools + Codex handler) ───

export interface AutomationToolCtx {
  agentProvider: AgentId
  cwd: string
  sessionId: string | undefined
}

/** Fired when manage_automations create or update persists, so the calling
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
function foreignAutomationLink(sessionId: string | undefined, automationId: string) {
  return foreignTaskLinksFor(sessionId).find(
    (link) => link.kind === 'automation' && link.targetKey === automationId,
  ) ?? null
}

/** The honest answer for a write against an automation that lives elsewhere. */
function foreignAutomationError(operation: string, automationId: string): string {
  return `Automation ${automationId} lives on the issue's host (this session was dispatched), and ${operation} cannot reach it from here. Manage it from the issue's host, or note the request in a comment_issue.`
}

/** The person whose turn calls the tool, as the run admitted them; the host's own work outside a turn. */
function toolActor(): Actor {
  return actorFor(workspaceToolAuthority() ?? INTERNAL_PRINCIPAL)
}

/**
 * Whether the tool's person holds `verb` on the automation (docs/plans/access-model.md
 * §4 D4): its owner, or an administrator. An automation they may not reach answers
 * as one that does not exist, so its id tells nothing.
 */
function mayReach(id: string, verb: ResourceVerb): boolean {
  const home = automationHomeOf(id)
  return !!home && roleAllows(roleOf(toolActor(), { kind: 'automation', id, ...home, acl: [] }), verb)
}

export async function executeAutomationTool(
  action: AutomationToolAction,
  args: AutomationToolArgs,
  deps: AutomationToolDeps = {},
): Promise<AutomationToolResult> {
  try {
    if (action === 'list') {
      const automations = await listAutomations(toolActor())
      if (automations.length === 0) return { ok: true, text: 'No automations exist yet.' }
      const lines = automations.map(
        (a) => `- ${a.id} — "${a.name}" (${a.archivedAt ? 'archived' : a.enabled ? 'enabled' : 'paused'})${a.lastRunStatus ? `, last run: ${a.lastRunStatus}` : ''}`,
      )
      return { ok: true, text: `Automations:\n${lines.join('\n')}` }
    }

    if (action === 'read') {
      const id = String(args.automation_id ?? '')
      if (!id) return { ok: false, text: 'read needs an automation_id.' }
      const a = mayReach(id, 'read') ? await loadAutomation(id) : null
      if (!a) {
        // A dispatched session's task may link an automation whose row lives
        // on the task's host; the link's snapshot facts are all this host has.
        const link = foreignAutomationLink(deps.ctx?.sessionId, id)
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

    if (action === 'create') {
      const name_ = args.name?.trim() ?? ''
      const prompt = args.prompt ?? ''
      if (!name_) return { ok: false, text: 'create needs a name.' }
      if (!prompt.trim()) return { ok: false, text: 'create needs a non-empty prompt.' }

      // An explicit cwd is a user choice and must survive unchanged. Only the
      // omitted default collapses the calling session back to its project root.
      const cwd = resolveAutomationCwd(args.cwd, deps.ctx?.cwd)
      const automationAction: AutomationAction = {
        prompt,
        // The run executes on the automation's chosen agent — defaults to the
        // caller's provider so "automate what I just did" runs on the same agent,
        // falling back to claude-code if the caller isn't a runnable provider.
        agentProvider: agentProvider(args.agent_provider ?? deps.ctx?.agentProvider, 'claude-code'),
        modelId: args.model_id ?? null,
        reasoningEffort: reasoning(args.reasoning_effort, 'medium'),
        cwd,
      }
      if (args.use_worktree === true) automationAction.useWorktree = true
      const enabled = args.enabled ?? true
      const triggerResult = toTrigger(args.trigger)
      if (!triggerResult.ok) return { ok: false, text: `create: ${triggerResult.error}` }
      // The automation runs with the preferences of the person this session works for (plans/018 §6).
      const preferences = sessionSettings(deps.ctx?.sessionId)?.preferences
      enforce(hostPolicies().forWork(deps.ctx?.sessionId ? await organizationOfSession(deps.ctx.sessionId) : LOCAL_ORGANIZATION_ID).selectionDenial(automationAction.agentProvider, automationAction.modelId))
      const created = await createAutomation(name_, automationAction, await toolAgentAttribution(deps.ctx), enabled, triggerResult.trigger, preferences)
      const when =
        created.trigger.type === 'manual'
          ? 'Start it with manage_automations run.'
          : `Scheduled (${created.trigger.type})${created.nextRunAt ? `; next run ${created.nextRunAt}` : ''}.`
      if (deps.ctx?.sessionId) {
        await linkSessionOutput(ANY_ORGANIZATION, deps.ctx.sessionId, {
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
      return { ok: true, text: `Created automation "${created.name}" (id: ${created.id}). ${when}` }
    }

    if (action === 'update') {
      const id = String(args.automation_id ?? '')
      if (!id) return { ok: false, text: 'update needs an automation_id.' }
      const existing = mayReach(id, 'edit') ? await loadAutomation(id) : null
      if (!existing) {
        if (foreignAutomationLink(deps.ctx?.sessionId, id)) {
          return { ok: false, text: foreignAutomationError('update', id) }
        }
        return { ok: false, text: `No automation found with id "${id}".` }
      }

      const actionPatch: Partial<AutomationAction> = {}
      if (args.prompt !== undefined) actionPatch.prompt = args.prompt
      if (args.cwd !== undefined) actionPatch.cwd = args.cwd
      if (args.use_worktree !== undefined) actionPatch.useWorktree = args.use_worktree
      if (args.agent_provider !== undefined) actionPatch.agentProvider = agentProvider(args.agent_provider, existing.action.agentProvider)
      if (args.model_id !== undefined) actionPatch.modelId = args.model_id
      // Switching provider without naming a model resets to that provider's
      // default — the old provider's model id would be meaningless on the new one.
      else if (actionPatch.agentProvider && actionPatch.agentProvider !== existing.action.agentProvider) actionPatch.modelId = null
      if (args.reasoning_effort !== undefined) actionPatch.reasoningEffort = reasoning(args.reasoning_effort, existing.action.reasoningEffort)

      let triggerPatch: AutomationTrigger | undefined
      if (args.trigger !== undefined) {
        const triggerResult = toTrigger(args.trigger)
        if (!triggerResult.ok) return { ok: false, text: `update: ${triggerResult.error}` }
        triggerPatch = triggerResult.trigger
      }

      const automationPatch: Parameters<typeof updateAutomation>[1] = {}
      if (args.archived !== undefined) automationPatch.archived = args.archived
      if (args.name !== undefined) automationPatch.name = args.name
      if (args.enabled !== undefined) automationPatch.enabled = args.enabled
      if (Object.keys(actionPatch).length) automationPatch.action = actionPatch
      if (triggerPatch) automationPatch.trigger = triggerPatch
      if (automationPatch.action) {
        const current = await loadAutomation(id)
        const next = { ...current?.action, ...automationPatch.action }
        if (current && next.agentProvider) enforce(hostPolicies().forWork(current.organizationId ?? LOCAL_ORGANIZATION_ID).selectionDenial(next.agentProvider, next.modelId))
      }
      const updated = await updateAutomation(id, automationPatch)
      if (updated && deps.ctx?.sessionId) {
        await linkSessionOutput(ANY_ORGANIZATION, deps.ctx.sessionId, {
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

    if (action === 'delete') {
      const id = String(args.automation_id ?? '')
      if (!id) return { ok: false, text: 'delete needs an automation_id.' }
      if (foreignAutomationLink(deps.ctx?.sessionId, id)) {
        return { ok: false, text: foreignAutomationError('delete', id) }
      }
      const ok = mayReach(id, 'edit') && await deleteAutomation(id)
      return ok
        ? { ok: true, text: `Deleted automation ${id}.` }
        : { ok: false, text: `No automation found with id "${id}".` }
    }

    if (action === 'run') {
      const id = String(args.automation_id ?? '')
      if (!id) return { ok: false, text: 'run needs an automation_id.' }
      const a = mayReach(id, 'drive') ? await loadAutomation(id) : null
      if (!a) {
        if (foreignAutomationLink(deps.ctx?.sessionId, id)) {
          return { ok: false, text: foreignAutomationError('run', id) }
        }
        return { ok: false, text: `No automation found with id "${id}".` }
      }
      if (!a.enabled) return { ok: false, text: `Automation "${a.name}" is paused. Enable it before running.` }
      if (hasActiveRun(a.id)) return { ok: false, text: `Automation "${a.name}" already has a run in progress. Wait for it to finish (read_automations runs shows its status) or cancel it first.` }
      const run = await triggerAutomationRun(a)
      return { ok: true, text: `Started run ${run.id} for "${a.name}". It runs in the background: use read_automations runs with automation_id "${a.id}" and run_id "${run.id}" for status and session_id, then read_session for agent output.` }
    }

    if (action === 'runs') {
      const id = String(args.automation_id ?? '')
      if (!id) return { ok: false, text: 'runs needs an automation_id.' }
      if (!mayReach(id, 'read')) return { ok: false, text: `No automation found with id "${id}".` }
      if (args.run_id !== undefined) {
        const run = await loadRun(id, args.run_id)
        if (!run) return { ok: false, text: `No run "${args.run_id}" found for automation "${id}".` }
        return { ok: true, text: describeRun(run) }
      }
      const runs = await listRuns(id)
      if (runs.length === 0) return { ok: true, text: 'This automation has no runs yet.' }
      return { ok: true, text: `Runs (newest first):\n${runs.map(describeRun).join('\n\n')}` }
    }

    return { ok: false, text: `Unknown automation action: ${String(action)}` }
  } catch (err: any) {
    log.error('automation_tool_failed', { action, error: err instanceof Error ? err.message : String(err) })
    return { ok: false, text: `Automation tool error: ${String(err?.message ?? err)}` }
  }
}

function automationAgentTool(
  name: string,
  description: string,
  inputFields: AgentTool['inputFields'],
  requiresApproval: boolean,
): AgentTool {
  return {
    name,
    description,
    inputFields,
    requiresApproval,
    execute: async (args, context) => executeAutomationTool(z.enum([...READ_ACTIONS, ...MANAGE_ACTIONS]).parse(args.action), args, {
      ctx: {
        agentProvider: context.provider,
        cwd: context.cwd,
        sessionId: context.sessionId(),
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

export const readAutomationsAgentTool = automationAgentTool('read_automations', READ_DESC, readFields, false)
/** Every change asks for approval; reading does not, so it is a separate tool. */
export const manageAutomationsAgentTool = automationAgentTool('manage_automations', MANAGE_DESC, manageFields(MANAGE_ACTIONS), true)
/** An automation run may edit its automation, never create, delete, or start one. */
export const updateAutomationAgentTool = automationAgentTool('manage_automations', 'Update an existing automation: any subset; unspecified fields stay. Pause or resume with enabled alone; archive with archived: true.', manageFields(['update']), true)

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AgentTool, AgentToolContext, AgentToolResult } from '../agents/tools/agent-tool'
import { resolveHomePath } from '../platform/paths'
import { stableSessionIdForProviderThread } from '../sessions/session-lineage'
import type { NormalizedEvent } from '@solus/contracts/types'
import type { Watch, WatchSchedule, WatchUntil } from '@solus/contracts/watch-types'
import { cancelWatch, listWatchesForSession, loadWatch, saveWatch } from './watches-store'
import {
  DEFAULT_EXPIRES_IN_HOURS,
  DEFAULT_MAX_WAKES,
  DEFAULT_PROBE_TIMEOUT_SECONDS,
  describeWatch,
  MAX_ACTIVE_WATCHES_PER_SESSION,
  MAX_EXPIRES_IN_HOURS,
  MAX_PROBE_TIMEOUT_SECONDS,
  MIN_WATCH_INTERVAL_SECONDS,
  validUntilPattern,
} from './watch-rules'

const WATCH_DESC = [
  'Wait for an outside result on the host, then wake this conversation with it. Use this when a task must wait for something that takes minutes or hours: CI checks, a deploy, a long job, a log line, a queue, or "check back in 30 minutes". Do not poll in a loop and do not keep a background shell open for long waits.',
  'The host runs `probe_command` every `every_seconds` with no model involved, and wakes you only when `until` matches. The probe runs in this session\'s working directory with no permission prompt. Nothing is spent while the result is not ready.',
  'Omit `probe_command` for a pure timer: set `at` (one wake) or `every_seconds` with `repeat: true`.',
  'Set `repeat: true` to watch again after you act, for example "fix CI until it is green": the watch re-arms when your turn ends and wakes you only for a new result, until `max_wakes`. Make the probe output stable (no timestamps or durations) so the same result does not look new.',
  'Example for CI: probe_command "gh pr checks 42 --required" (exit 8 means pending), until_exit_codes [0, 1], every_seconds 60, repeat true. On exit 0 you are done: call cancel_watch.',
].join('\n\n')
const LIST_DESC = 'List the watches of this conversation with their state, wakes used, and next run.'
const CANCEL_DESC = 'Cancel a watch of this conversation. Call this when the watched task is complete or the user asks you to stop.'

const watchFields = {
  reason: z.string().describe('What you must do when woken, in one sentence. The user sees it on the watch card.'),
  probe_command: z.string().optional().describe('Shell command the host runs to read the current state. Omit for a pure timer.'),
  probe_timeout_seconds: z.number().int().positive().optional().describe(`Seconds before a probe run is stopped. Default ${DEFAULT_PROBE_TIMEOUT_SECONDS}, maximum ${MAX_PROBE_TIMEOUT_SECONDS}.`),
  every_seconds: z.number().int().positive().optional().describe(`Seconds between probe runs, minimum ${MIN_WATCH_INTERVAL_SECONDS}. Required with a probe.`),
  at: z.string().optional().describe('Timer only: ISO-8601 instant to wake at.'),
  until_exit_codes: z.array(z.number().int()).optional().describe('The wait ends when the probe exits with one of these codes.'),
  until_output_matches: z.string().optional().describe('The wait ends when the probe output matches this regular expression.'),
  until_output_changes: z.boolean().optional().describe('The wait ends when the probe output differs from its first run.'),
  on_match: z.enum(['wake', 'notify']).optional().describe("'wake' (default) wakes you with the result. 'notify' only tells the user."),
  repeat: z.boolean().optional().describe('Watch again after the woken turn ends. Default false.'),
  max_wakes: z.number().int().positive().max(50).optional().describe(`Most times this watch may wake you. Default ${DEFAULT_MAX_WAKES}.`),
  expires_in_hours: z.number().positive().max(MAX_EXPIRES_IN_HOURS).optional().describe(`The watch ends after this many hours. Default ${DEFAULT_EXPIRES_IN_HOURS}.`),
}
const listFields = {}
const cancelFields = {
  watch_id: z.string().describe('The id of the watch (from list_watches or the wake prompt).'),
}

type WatchInput = z.output<z.ZodObject<typeof watchFields>>

/** The stable session a tool call belongs to: the host routes wakes by it. */
function callingSessionId(context: AgentToolContext): string | undefined {
  const providerThread = context.sessionId()
  return context.solusSessionId() ?? (providerThread ? stableSessionIdForProviderThread(providerThread) : undefined)
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

function parseUntil(input: WatchInput): Parsed<WatchUntil | undefined> {
  const conditions: WatchUntil[] = []
  if (input.until_exit_codes?.length) conditions.push({ exitCodes: input.until_exit_codes })
  if (input.until_output_matches !== undefined) {
    const error = validUntilPattern(input.until_output_matches)
    if (error) return { ok: false, error: `until_output_matches is not a valid regular expression: ${error}` }
    conditions.push({ outputMatches: input.until_output_matches })
  }
  if (input.until_output_changes) conditions.push({ outputChanges: true })
  if (conditions.length > 1) return { ok: false, error: 'Set only one of until_exit_codes, until_output_matches, until_output_changes.' }
  if (input.probe_command && conditions.length === 0) {
    return { ok: false, error: 'A probe needs an until condition: until_exit_codes, until_output_matches, or until_output_changes.' }
  }
  if (!input.probe_command && conditions.length) return { ok: false, error: 'An until condition needs a probe_command.' }
  return { ok: true, value: conditions[0] }
}

function parseSchedule(input: WatchInput, now: Date): Parsed<WatchSchedule> {
  if (input.at !== undefined) {
    if (input.probe_command) return { ok: false, error: '`at` is for a timer without a probe. Use every_seconds with a probe.' }
    if (input.repeat) return { ok: false, error: '`at` fires once. Use every_seconds with repeat: true for a repeating timer.' }
    const at = Date.parse(input.at)
    if (!Number.isFinite(at)) return { ok: false, error: '`at` must be an ISO-8601 instant.' }
    return { ok: true, value: { at: new Date(Math.max(at, now.getTime())).toISOString() } }
  }
  if (input.every_seconds === undefined) return { ok: false, error: 'Set every_seconds (or `at` for a single timer).' }
  if (input.every_seconds < MIN_WATCH_INTERVAL_SECONDS) {
    return { ok: false, error: `every_seconds must be at least ${MIN_WATCH_INTERVAL_SECONDS}.` }
  }
  return { ok: true, value: { everySeconds: input.every_seconds } }
}

/** Build a watch from the tool input, or say what is wrong with it. Exported
 *  for tests; the tool saves what this returns. */
export function watchFromInput(input: WatchInput, sessionId: string, cwd: string, now = new Date()): Parsed<Watch> {
  const reason = input.reason.trim()
  if (!reason) return { ok: false, error: 'reason cannot be empty.' }
  const command = input.probe_command?.trim()
  if (input.probe_command !== undefined && !command) return { ok: false, error: 'probe_command cannot be empty.' }
  const until = parseUntil({ ...input, probe_command: command })
  if (!until.ok) return until
  const schedule = parseSchedule({ ...input, probe_command: command }, now)
  if (!schedule.ok) return schedule
  const onMatch = input.on_match ?? 'wake'
  if (onMatch === 'notify' && input.repeat) return { ok: false, error: "on_match: 'notify' ends the watch when the condition is met; it cannot repeat." }
  const nowIso = now.toISOString()
  const watch: Watch = {
    id: randomUUID(),
    sessionId,
    cwd: resolveHomePath(cwd),
    reason,
    schedule: schedule.value,
    onMatch,
    repeat: input.repeat ?? false,
    maxWakes: input.max_wakes ?? DEFAULT_MAX_WAKES,
    expiresAt: new Date(now.getTime() + (input.expires_in_hours ?? DEFAULT_EXPIRES_IN_HOURS) * 3_600_000).toISOString(),
    wakeCount: 0,
    consecutiveProbeErrors: 0,
    // A probe reads the state at once; a timer waits for its first fire.
    nextRunAt: 'at' in schedule.value
      ? schedule.value.at
      : command ? nowIso : new Date(now.getTime() + schedule.value.everySeconds * 1000).toISOString(),
    status: 'waiting',
    createdAt: nowIso,
    updatedAt: nowIso,
  }
  if (command) {
    watch.probe = {
      command,
      timeoutSeconds: Math.min(input.probe_timeout_seconds ?? DEFAULT_PROBE_TIMEOUT_SECONDS, MAX_PROBE_TIMEOUT_SECONDS),
    }
  }
  if (until.value) watch.until = until.value
  return { ok: true, value: watch }
}

export const watchAgentTool: AgentTool = {
  name: 'watch',
  description: WATCH_DESC,
  inputFields: watchFields,
  // Decision (docs/plans/watches.md §5): watches run with no permission
  // prompt. The card, the watch list, and the limits are the controls.
  requiresApproval: false,
  alwaysLoad: true,
  async execute(args, context): Promise<AgentToolResult> {
    const input = z.object(watchFields).parse(args)
    const sessionId = callingSessionId(context)
    if (!sessionId) return { ok: false, text: 'watch must be called from a conversation.' }
    const active = listWatchesForSession(sessionId).filter((watch) => watch.status === 'waiting' || watch.status === 'woken' || watch.status === 'paused')
    if (active.length >= MAX_ACTIVE_WATCHES_PER_SESSION) {
      return { ok: false, text: `This conversation already has ${active.length} active watches. Cancel one before you add another.` }
    }
    const built = watchFromInput(input, sessionId, context.cwd)
    if (!built.ok) return { ok: false, text: `watch: ${built.error}` }
    const watch = saveWatch(built.value)
    const saved: Extract<NormalizedEvent, { type: 'watch_saved' }> = { type: 'watch_saved', watchId: watch.id, reason: watch.reason }
    if (watch.probe) saved.command = watch.probe.command
    context.emit(saved)
    const when = watch.probe
      ? 'The first probe runs now.'
      : `It fires at ${watch.nextRunAt}.`
    return {
      ok: true,
      text: `Created watch ${watch.id}. ${when} End your turn: you are woken when the wait ends. Expires ${watch.expiresAt}.`,
    }
  },
}

export const listWatchesAgentTool: AgentTool = {
  name: 'list_watches',
  description: LIST_DESC,
  inputFields: listFields,
  requiresApproval: false,
  async execute(_input, context): Promise<AgentToolResult> {
    const sessionId = callingSessionId(context)
    if (!sessionId) return { ok: false, text: 'list_watches must be called from a conversation.' }
    const watches = listWatchesForSession(sessionId)
    if (watches.length === 0) return { ok: true, text: 'This conversation has no watches.' }
    return { ok: true, text: `Watches (newest first):\n${watches.map((watch) => `- ${describeWatch(watch)}`).join('\n')}` }
  },
}

export const cancelWatchAgentTool: AgentTool = {
  name: 'cancel_watch',
  description: CANCEL_DESC,
  inputFields: cancelFields,
  requiresApproval: false,
  async execute(args, context): Promise<AgentToolResult> {
    const input = z.object(cancelFields).parse(args)
    const sessionId = callingSessionId(context)
    const watch = loadWatch(input.watch_id)
    // A conversation controls only its own watches.
    if (!watch || watch.sessionId !== sessionId) return { ok: false, text: `No watch "${input.watch_id}" in this conversation.` }
    const cancelled = cancelWatch(watch.id, 'agent')
    if (!cancelled) return { ok: true, text: `Watch ${watch.id} had already ended (${watch.status}).` }
    return { ok: true, text: `Cancelled watch ${watch.id}.` }
  },
}

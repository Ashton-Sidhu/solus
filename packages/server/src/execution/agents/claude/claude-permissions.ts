import { createLogger } from '../../../logger'
import { z } from 'zod'
import type { CanUseTool, PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'
import type { NormalizedEvent, PermissionOption, PermissionToolInput } from '@solus/contracts/types'

const log = createLogger('Permissions', 'permissions.ts')

const SENSITIVE_FIELD_RE = /token|password|secret|key|auth|credential|api.?key/i

const permissionToolInputSchema = z.object({
  command: z.json().optional(),
  cwd: z.json().optional(),
  description: z.json().optional(),
  plan: z.json().optional(),
  planFilePath: z.json().optional(),
  url: z.json().optional(),
  old_string: z.json().optional(),
  new_string: z.json().optional(),
  changes: z.json().optional(),
})

export function maskSensitiveFields(input: PermissionToolInput): PermissionToolInput {
  const parsed = permissionToolInputSchema.safeParse(input)
  if (!parsed.success) return {}

  const maskedJson = JSON.stringify(parsed.data, (key, value) =>
    SENSITIVE_FIELD_RE.test(key) ? '***' : value)
  const masked = permissionToolInputSchema.safeParse(JSON.parse(maskedJson))
  return masked.success ? masked.data : {}
}

/**
 * The rules "Allow for Session" adds. The SDK's own suggestions are narrowest
 * (a Bash prefix, one directory), but they usually target a settings file, so
 * they are rewritten to the session: a click in Solus never edits the user's
 * settings. Without suggestions the whole tool is allowed, except Bash, where
 * that would allow every command.
 */
export function sessionPermissionUpdates(toolName: string, suggestions: PermissionUpdate[] | undefined): PermissionUpdate[] | null {
  if (suggestions?.length) return suggestions.map((update) => ({ ...update, destination: 'session' }))
  if (toolName === 'Bash') return null
  return [{ type: 'addRules', rules: [{ toolName }], behavior: 'allow', destination: 'session' }]
}

const ALLOW_ONCE: PermissionOption = { id: 'allow', label: 'Allow Once', kind: 'allow' }
const ALLOW_SESSION: PermissionOption = { id: 'allow-session', label: 'Allow for Session', kind: 'allow' }
const DENY: PermissionOption = { id: 'deny', label: 'Deny', kind: 'deny' }

interface PendingPermission {
  resolve: (result: PermissionResult) => void
  input: Record<string, unknown>
  toolName: string
  sessionId: string | null
  sessionUpdates: PermissionUpdate[] | null
}

/**
 * Bridges the SDK's canUseTool callback to the permission card. The SDK decides
 * which calls need a person — from the session's permission mode and the user's
 * own settings — so every call that reaches here is shown, except the two tools
 * Solus answers itself: AskUserQuestion (a question card) and ExitPlanMode (the
 * plan review).
 */
export class PermissionManager {
  private pendingPermissions = new Map<string, PendingPermission>()
  private pendingQuestions = new Map<string, { resolve: (result: PermissionResult) => void; input: any; sessionId: string | null }>()
  /**
   * Fallback sessionId for permissions created before session_init arrived
   * (first prompt of a new tab). SessionRuntime pushes the real id in here.
   */
  private currentSessionId: string | null = null
  public onPermissionEvent: ((sessionId: string | null, event: NormalizedEvent) => void) | null = null

  setCurrentSessionId(sessionId: string): void {
    this.currentSessionId = sessionId
    log.debug('current_session_id_set', { sessionId })
  }

  /** Build a canUseTool callback bound to a specific run.
   * `sessionRef` is a mutable holder so the closure always reads the
   * up-to-date sessionId (updated by the backend after session_init). */
  createCanUseTool(sessionRef: { current: string | null }, unattended = false): CanUseTool {
    return async (toolName, input: any, options) => {
      const sessionId = sessionRef.current
      // EnterPlanMode is denied too: nobody can approve the resulting plan, so a
      // run that enters plan mode can never leave it.
      if (
        unattended &&
        (toolName === 'AskUserQuestion' ||
          toolName === 'ExitPlanMode' ||
          toolName === 'EnterPlanMode')
      ) {
        return {
          behavior: 'deny',
          message: 'This background run is unattended. Continue with the supplied scope and your best judgment.',
        }
      }

      // ExitPlanMode always requires user review — the plan is in input.plan/planFilePath.
      if (toolName === 'ExitPlanMode') {
        const questionId = `perm-${crypto.randomUUID()}`
        const planContent = z.string().catch('').parse(input?.plan)
        if (planContent.trim()) {
          const planEvent: NormalizedEvent = {
            type: 'plan',
            planContent,
            planFilePath: input?.planFilePath || '',
            questionId,
            planToolUseId: options.toolUseID,
            options: [
              { id: 'allow', label: 'Yes', kind: 'allow' },
              { id: 'deny', label: 'No', kind: 'deny' },
            ],
          }
          log.info('exit_plan_mode_plan_review', { questionId })
          this.onPermissionEvent?.(sessionId, planEvent)
        } else {
          log.info('exit_plan_mode_empty_plan', { questionId })
          this.onPermissionEvent?.(sessionId, {
            type: 'permission_request',
            questionId,
            toolName,
            toolUseId: options.toolUseID,
            toolDescription: input?.description,
            toolInput: input ? maskSensitiveFields(input) : undefined,
            options: [ALLOW_ONCE, DENY],
          })
        }
        return new Promise((resolve) => {
          this.pendingPermissions.set(questionId, { resolve, input, toolName, sessionId, sessionUpdates: null })
        })
      }

      // AskUserQuestion has no valid auto-answer. Interactive runs route it to
      // the renderer; unattended utilities must continue without parking.
      if (toolName === 'AskUserQuestion') {
        const questionId = `question-${crypto.randomUUID()}`
        const questionEvent: NormalizedEvent = {
          type: 'question_request',
          questionId,
          questions: (input?.questions ?? []).map((q: any) => ({
            question: q.question,
            header: q.header,
            options: (q.options ?? []).map((o: any) => ({ label: o.label, description: o.description, preview: o.preview })),
            multiSelect: q.multiSelect ?? false,
          })),
        }
        log.info('question_request', { questionId, questionCount: questionEvent.questions.length })
        const effectiveSessionId = sessionId ?? this.currentSessionId
        this.onPermissionEvent?.(effectiveSessionId, questionEvent)
        return new Promise((resolve) => {
          this.pendingQuestions.set(questionId, { resolve, input, sessionId: effectiveSessionId })
        })
      }

      const questionId = `perm-${crypto.randomUUID()}`
      const sessionUpdates = sessionPermissionUpdates(toolName, options.suggestions)
      log.info('permission_prompt_shown', { questionId, toolName })
      this.onPermissionEvent?.(sessionId, {
        type: 'permission_request',
        questionId,
        toolName,
        toolUseId: options.toolUseID,
        toolDescription: input?.description ?? options.title,
        toolInput: input ? maskSensitiveFields(input) : undefined,
        options: sessionUpdates ? [ALLOW_ONCE, ALLOW_SESSION, DENY] : [ALLOW_ONCE, DENY],
      })

      return new Promise((resolve) => {
        this.pendingPermissions.set(questionId, { resolve, input, toolName, sessionId, sessionUpdates })
      })
    }
  }

  getPendingInfo(questionId: string): { toolName: string; sessionId: string | null } | undefined {
    const p = this.pendingPermissions.get(questionId)
    return p ? { toolName: p.toolName, sessionId: p.sessionId } : undefined
  }

  /**
   * Resolve a pending permission. `decision` is 'allow', 'allow-session', or
   * 'deny'; anything else denies. `updatedPlan` replaces `input.plan` for
   * ExitPlanMode approvals.
   */
  respondToPermission(questionId: string, decision: string, updatedPlan?: string): boolean {
    const pending = this.pendingPermissions.get(questionId)
    if (!pending) {
      log.info('permission_response_no_pending', { questionId })
      return false
    }

    this.pendingPermissions.delete(questionId)

    if (decision !== 'allow' && decision !== 'allow-session') {
      log.info('permission_denied', { toolName: pending.toolName, decision })
      pending.resolve({ behavior: 'deny', message: 'User denied this action' })
      return true
    }

    log.info('permission_allowed', { toolName: pending.toolName, decision })
    // Swap in the user-edited plan so Claude resumes from the edited version, not the original.
    const updatedInput =
      updatedPlan && pending.toolName === 'ExitPlanMode'
        ? { ...pending.input, plan: updatedPlan }
        : pending.input
    const updatedPermissions = decision === 'allow-session' ? pending.sessionUpdates : null
    pending.resolve(updatedPermissions
      ? { behavior: 'allow', updatedInput, updatedPermissions }
      : { behavior: 'allow', updatedInput })
    return true
  }

  respondToQuestion(questionId: string, answers: Record<string, string>): boolean {
    const pending = this.pendingQuestions.get(questionId)
    if (!pending) {
      log.info('question_response_no_pending', { questionId })
      return false
    }
    this.pendingQuestions.delete(questionId)
    pending.resolve({
      behavior: 'allow',
      updatedInput: { questions: pending.input?.questions ?? [], answers },
    })
    return true
  }

  /**
   * Deny all pending permissions/questions for a session when it exits.
   */
  clearPendingForSession(sessionId: string): void {
    for (const [id, pending] of this.pendingPermissions) {
      const pendingSession = pending.sessionId ?? this.currentSessionId
      if (pendingSession !== sessionId) continue
      pending.resolve({ behavior: 'deny', message: 'Run cancelled' })
      this.pendingPermissions.delete(id)
    }
    for (const [id, pending] of this.pendingQuestions) {
      const pendingSession = pending.sessionId ?? this.currentSessionId
      if (pendingSession !== sessionId) continue
      pending.resolve({ behavior: 'deny', message: 'Run cancelled' })
      this.pendingQuestions.delete(id)
    }
  }
}

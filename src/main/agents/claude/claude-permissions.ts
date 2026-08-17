import { createLogger } from '../../logger'
import { z } from 'zod'
import type { NormalizedEvent, PermissionOption, PermissionToolInput } from '../../../shared/types'

const log = createLogger('Permissions', 'permissions.ts')

// Tools that need explicit user approval via the permission card.
const PERMISSION_REQUIRED_TOOLS = ['Bash', 'Edit', 'Write', 'MultiEdit']

// Bash commands that are clearly read-only and safe to auto-approve.
const SAFE_BASH_COMMANDS = new Set([
  'cat', 'head', 'tail', 'less', 'more', 'wc', 'file', 'stat',
  'ls', 'pwd', 'echo', 'printf', 'date', 'whoami', 'hostname', 'uname',
  'which', 'whence', 'where', 'type', 'command',
  'man', 'help', 'info',
  'find', 'grep', 'rg', 'ag', 'ack', 'fd', 'fzf', 'locate',
  'git',
  'env', 'printenv', 'set',
  'npm', 'yarn', 'pnpm', 'bun', 'cargo', 'pip', 'pip3', 'go', 'rustup',
  'node', 'python', 'python3', 'ruby', 'java', 'javac',
  'claude',
  'df', 'du', 'free', 'top', 'htop', 'ps', 'uptime', 'lsof',
  'tree', 'realpath', 'dirname', 'basename',
  'sw_vers', 'system_profiler', 'defaults', 'mdls', 'mdfind',
  'diff', 'cmp', 'comm', 'sort', 'uniq', 'cut', 'awk', 'sed',
  'jq', 'yq', 'xargs', 'tr',
])

const GIT_MUTATING_SUBCOMMANDS = new Set([
  'push', 'commit', 'merge', 'rebase', 'reset', 'checkout', 'switch',
  'branch', 'tag', 'stash', 'cherry-pick', 'revert', 'am', 'apply',
  'clean', 'rm', 'mv', 'restore', 'bisect', 'pull', 'fetch', 'clone',
  'init', 'submodule', 'worktree', 'gc', 'prune', 'filter-branch',
])

const CLAUDE_MUTATING_SUBCOMMANDS = new Set(['config', 'login', 'logout'])

const SENSITIVE_FIELD_RE = /token|password|secret|key|auth|credential|api.?key/i
const VALID_ALLOW_DECISIONS = new Set(['allow', 'allow-session', 'allow-domain'])
const VALID_DECISIONS = new Set([...VALID_ALLOW_DECISIONS, 'deny'])

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

export function isSafeBashCommand(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed) return false

  const segments = trimmed.split(/\s*(?:;|&&|\|\||[|])\s*/)
  for (const segment of segments) {
    const parts = segment.trim().split(/\s+/)
    const cmd = parts[0]
    if (!cmd) continue

    const actualCmd = cmd.includes('=') ? parts[1] : cmd
    if (!actualCmd) continue

    const base = actualCmd.split('/').pop() || actualCmd

    if (!SAFE_BASH_COMMANDS.has(base)) return false

    if (base === 'git') {
      const subIdx = cmd.includes('=') ? 2 : 1
      const sub = parts[subIdx]
      if (sub && GIT_MUTATING_SUBCOMMANDS.has(sub)) return false
    }

    if (base === 'claude') {
      const subIdx = cmd.includes('=') ? 2 : 1
      const sub = parts[subIdx]
      if (sub && CLAUDE_MUTATING_SUBCOMMANDS.has(sub)) return false
      if (sub === 'mcp') {
        const mcpSub = parts[subIdx + 1]
        if (mcpSub && mcpSub !== 'list' && mcpSub !== 'get' && mcpSub !== '--help') return false
      }
    }

    if (['npm', 'yarn', 'pnpm', 'bun'].includes(base)) {
      const subIdx = cmd.includes('=') ? 2 : 1
      const sub = parts[subIdx]
      if (sub && ['install', 'i', 'add', 'remove', 'uninstall', 'publish', 'run', 'exec', 'dlx', 'npx', 'create', 'init', 'link', 'unlink', 'pack', 'deprecate'].includes(sub)) return false
    }

    if (segment.includes('>') && !segment.includes('>/dev/null') && !segment.includes('2>/dev/null') && !segment.includes('2>&1')) return false
  }

  return true
}

function extractDomain(url: string): string | null {
  try { return new URL(url).hostname } catch { return null }
}

export function maskSensitiveFields(input: PermissionToolInput): PermissionToolInput {
  const parsed = permissionToolInputSchema.safeParse(input)
  if (!parsed.success) return {}

  const maskedJson = JSON.stringify(parsed.data, (key, value) =>
    SENSITIVE_FIELD_RE.test(key) ? '***' : value)
  const masked = permissionToolInputSchema.safeParse(JSON.parse(maskedJson))
  return masked.success ? masked.data : {}
}

function getOptionsForTool(toolName: string): PermissionOption[] {
  if (toolName === 'Bash') {
    return [
      { id: 'allow', label: 'Allow Once', kind: 'allow' },
      { id: 'deny', label: 'Deny', kind: 'deny' },
    ]
  }
  return [
    { id: 'allow', label: 'Allow Once', kind: 'allow' },
    { id: 'allow-session', label: 'Allow for Session', kind: 'allow' },
    { id: 'deny', label: 'Deny', kind: 'deny' },
  ]
}

interface PendingPermission {
  resolve: (result: any) => void
  input: any
  toolName: string
  sessionId: string | null
}

/**
 * Drives the SDK's canUseTool callback: emits permission_request events, tracks
 * pending approvals, and persists session-scoped allows (keys: `session:<id>:tool:<name>`
 * and `session:<id>:webfetch:<domain>`).
 */
export class PermissionManager {
  private pendingPermissions = new Map<string, PendingPermission>()
  private pendingQuestions = new Map<string, { resolve: (result: any) => void; input: any; sessionId: string | null }>()
  private scopedAllows = new Set<string>()
  /**
   * Fallback sessionId for permissions created before session_init arrived
   * (first prompt of a new tab). ControlPlane pushes the real id in here.
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
  createCanUseTool(
    sessionRef: { current: string | null },
    mode: 'ask' | 'auto' | 'plan' = 'ask',
    unattended = false,
  ): (toolName: string, input: any, options?: { toolUseID?: string }) => Promise<any> {
    return async (toolName: string, input: any, options?: { toolUseID?: string }) => {
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
            planToolUseId: options?.toolUseID || '',
            options: [
              { id: 'allow', label: 'Yes', kind: 'allow' },
              { id: 'deny', label: 'No', kind: 'deny' },
            ],
          }
          log.info('exit_plan_mode_plan_review', { questionId })
          this.onPermissionEvent?.(sessionId, planEvent)
        } else {
          const safeInput = input ? maskSensitiveFields(input) : undefined
          const permEvent: NormalizedEvent = {
            type: 'permission_request',
            questionId,
            toolName,
            toolDescription: input?.description,
            toolInput: safeInput,
            options: [
              { id: 'allow', label: 'Allow Once', kind: 'allow' },
              { id: 'deny', label: 'Deny', kind: 'deny' },
            ],
          }
          log.info('exit_plan_mode_empty_plan', { questionId })
          this.onPermissionEvent?.(sessionId, permEvent)
        }
        return new Promise((resolve) => {
          this.pendingPermissions.set(questionId, { resolve, input, toolName, sessionId })
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

      if (mode === 'auto' || mode === 'plan') {
        return { behavior: 'allow', updatedInput: input }
      }

      // Tools outside PERMISSION_REQUIRED_TOOLS (and non-MCP tools) never prompt.
      if (!PERMISSION_REQUIRED_TOOLS.includes(toolName) && !toolName.startsWith('mcp__')) {
        return { behavior: 'allow', updatedInput: input }
      }

      // Fall back to currentSessionId when this run started before session_init arrived.
      const effectiveSessionId = sessionId ?? this.currentSessionId
      if (effectiveSessionId && this.scopedAllows.has(`session:${effectiveSessionId}:tool:${toolName}`)) {
        log.debug('auto_allow_session_tool', { toolName, sessionId: effectiveSessionId })
        return { behavior: 'allow', updatedInput: input }
      }

      if (toolName === 'WebFetch' && effectiveSessionId) {
        const parsedUrl = z.string().safeParse(input?.url)
        const domain = parsedUrl.success ? extractDomain(parsedUrl.data) : null
        if (domain && this.scopedAllows.has(`session:${effectiveSessionId}:webfetch:${domain}`)) {
          log.debug('auto_allow_webfetch_domain', { domain, sessionId: effectiveSessionId })
          return { behavior: 'allow', updatedInput: input }
        }
      }

      const parsedCommand = z.string().safeParse(input?.command)
      if (toolName === 'Bash' && parsedCommand.success && isSafeBashCommand(parsedCommand.data)) {
        log.debug('auto_allow_safe_bash', { command: String(input?.command) })
        return { behavior: 'allow', updatedInput: input }
      }

      const questionId = `perm-${crypto.randomUUID()}`

      const safeInput = input ? maskSensitiveFields(input) : undefined

      const permEvent: NormalizedEvent = {
        type: 'permission_request',
        questionId,
        toolName,
        toolDescription: input?.description,
        toolInput: safeInput,
        options: getOptionsForTool(toolName),
      }

      log.info('permission_prompt_shown', { questionId, toolName })
      this.onPermissionEvent?.(sessionId, permEvent)

      return new Promise((resolve) => {
        this.pendingPermissions.set(questionId, { resolve, input, toolName, sessionId })
      })
    }
  }

  /**
   * Resolve a pending permission. `decision` must be one of
   * 'allow' | 'allow-session' | 'allow-domain' | 'deny'.
   * `updatedPlan` replaces `input.plan` for ExitPlanMode approvals.
   */
  getPendingInfo(questionId: string): { toolName: string; sessionId: string | null } | undefined {
    const p = this.pendingPermissions.get(questionId)
    return p ? { toolName: p.toolName, sessionId: p.sessionId } : undefined
  }

  respondToPermission(questionId: string, decision: string, updatedPlan?: string): boolean {
    const pending = this.pendingPermissions.get(questionId)
    if (!pending) {
      log.info('permission_response_no_pending', { questionId })
      return false
    }

    this.pendingPermissions.delete(questionId)

    // Fail closed: any unknown decision resolves to deny.
    if (!VALID_DECISIONS.has(decision)) {
      log.info('unknown_decision_denied', { decision, questionId })
      pending.resolve({ behavior: 'deny', message: `Unknown decision: ${decision}` })
      return true
    }

    // Same fallback as createCanUseTool: pending.sessionId is null for first-run perms.
    const resolvedSessionId = pending.sessionId ?? this.currentSessionId
    if (decision === 'allow-session' && resolvedSessionId) {
      const key = `session:${resolvedSessionId}:tool:${pending.toolName}`
      this.scopedAllows.add(key)
      log.info('session_allowed', { toolName: pending.toolName, sessionId: resolvedSessionId })
    } else if (decision === 'allow-domain' && resolvedSessionId) {
      const domain = extractDomain(pending.input?.url)
      if (domain) {
        const key = `session:${resolvedSessionId}:webfetch:${domain}`
        this.scopedAllows.add(key)
        log.info('domain_allowed', { domain, sessionId: resolvedSessionId })
      }
    }

    if (VALID_ALLOW_DECISIONS.has(decision)) {
      log.info('permission_allowed', { toolName: pending.toolName })
      // Swap in the user-edited plan so Claude resumes from the edited version, not the original.
      const resolvedInput =
        updatedPlan && pending.toolName === 'ExitPlanMode'
          ? { ...pending.input, plan: updatedPlan }
          : pending.input
      pending.resolve({ behavior: 'allow', updatedInput: resolvedInput })
    } else {
      log.info('permission_denied', { toolName: pending.toolName })
      pending.resolve({ behavior: 'deny', message: 'User denied this action' })
    }

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
    const effectiveId = sessionId
    for (const [id, pending] of this.pendingPermissions) {
      const pendingSession = pending.sessionId ?? this.currentSessionId
      if (pendingSession !== effectiveId) continue
      pending.resolve({ behavior: 'deny', message: 'Run cancelled' })
      this.pendingPermissions.delete(id)
    }
    for (const [id, pending] of this.pendingQuestions) {
      const pendingSession = pending.sessionId ?? this.currentSessionId
      if (pendingSession !== effectiveId) continue
      pending.resolve({ behavior: 'deny', message: 'Run cancelled' })
      this.pendingQuestions.delete(id)
    }
  }
}

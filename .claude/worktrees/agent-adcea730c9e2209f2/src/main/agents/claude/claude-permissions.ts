import { createLogger } from '../../logger'
import type { NormalizedEvent, PermissionOption } from '../../../shared/types'

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

export function isSafeBashCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false
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

function extractDomain(url: unknown): string | null {
  if (typeof url !== 'string') return null
  try { return new URL(url).hostname } catch { return null }
}

export function maskSensitiveFields(input: Record<string, unknown>): Record<string, unknown> {
  const masked: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (SENSITIVE_FIELD_RE.test(key)) {
      masked[key] = '***'
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      masked[key] = maskSensitiveFields(value as Record<string, unknown>)
    } else if (Array.isArray(value)) {
      masked[key] = value.map(item =>
        item !== null && typeof item === 'object' && !Array.isArray(item)
          ? maskSensitiveFields(item as Record<string, unknown>)
          : item
      )
    } else {
      masked[key] = value
    }
  }
  return masked
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
    log.debug(`currentSessionId set to ${sessionId.substring(0, 8)}…`)
  }

  /** Build a canUseTool callback bound to a specific run.
   * `sessionRef` is a mutable holder so the closure always reads the
   * up-to-date sessionId (updated by the backend after session_init). */
  createCanUseTool(sessionRef: { current: string | null }, mode: 'ask' | 'auto' | 'plan' = 'ask'): (toolName: string, input: any, options?: { toolUseID?: string }) => Promise<any> {
    return async (toolName: string, input: any, options?: { toolUseID?: string }) => {
      const sessionId = sessionRef.current
      // ExitPlanMode always requires user review — the plan is in input.plan/planFilePath.
      if (toolName === 'ExitPlanMode') {
        const questionId = `perm-${crypto.randomUUID()}`
        const planContent = typeof input?.plan === 'string' ? input.plan : ''
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
          log.info(`ExitPlanMode blocked for plan review [${questionId}]`)
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
          log.info(`ExitPlanMode blocked with empty plan content [${questionId}]`)
          this.onPermissionEvent?.(sessionId, permEvent)
        }
        return new Promise((resolve) => {
          this.pendingPermissions.set(questionId, { resolve, input, toolName, sessionId })
        })
      }

      // AskUserQuestion has no valid auto-answer; always route to the renderer.
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
        log.info(`Question request [${questionId}]: ${questionEvent.questions.length} question(s)`)
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
        log.debug(`Auto-allowing ${toolName} (session-allowed)`)
        return { behavior: 'allow', updatedInput: input }
      }

      if (toolName === 'WebFetch' && effectiveSessionId) {
        const domain = extractDomain(input?.url)
        if (domain && this.scopedAllows.has(`session:${effectiveSessionId}:webfetch:${domain}`)) {
          log.debug(`Auto-allowing WebFetch to ${domain} (domain-allowed)`)
          return { behavior: 'allow', updatedInput: input }
        }
      }

      if (toolName === 'Bash' && isSafeBashCommand(input?.command)) {
        log.debug(`Auto-allowing safe Bash: ${String(input?.command).substring(0, 80)}`)
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

      log.info(`Permission request [${questionId}]: tool=${toolName}`)
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
      log.info(`respondToPermission: no pending request for ${questionId}`)
      return false
    }

    this.pendingPermissions.delete(questionId)

    // Fail closed: any unknown decision resolves to deny.
    if (!VALID_DECISIONS.has(decision)) {
      log.info(`Unknown decision "${decision}" for [${questionId}] — denying (fail-closed)`)
      pending.resolve({ behavior: 'deny', message: `Unknown decision: ${decision}` })
      return true
    }

    // Same fallback as createCanUseTool: pending.sessionId is null for first-run perms.
    const resolvedSessionId = pending.sessionId ?? this.currentSessionId
    if (decision === 'allow-session' && resolvedSessionId) {
      const key = `session:${resolvedSessionId}:tool:${pending.toolName}`
      this.scopedAllows.add(key)
      log.info(`Session-allowed ${pending.toolName} for session ${resolvedSessionId.substring(0, 8)}…`)
    } else if (decision === 'allow-domain' && resolvedSessionId) {
      const domain = extractDomain(pending.input?.url)
      if (domain) {
        const key = `session:${resolvedSessionId}:webfetch:${domain}`
        this.scopedAllows.add(key)
        log.info(`Domain-allowed ${domain} for session ${resolvedSessionId.substring(0, 8)}…`)
      }
    }

    if (VALID_ALLOW_DECISIONS.has(decision)) {
      log.info(`Permission: ${pending.toolName} → allow`)
      // Swap in the user-edited plan so Claude resumes from the edited version, not the original.
      const resolvedInput =
        updatedPlan && pending.toolName === 'ExitPlanMode'
          ? { ...pending.input, plan: updatedPlan }
          : pending.input
      pending.resolve({ behavior: 'allow', updatedInput: resolvedInput })
    } else {
      log.info(`Permission: ${pending.toolName} → deny`)
      pending.resolve({ behavior: 'deny', message: 'User denied this action' })
    }

    return true
  }

  respondToQuestion(questionId: string, answers: Record<string, string>): boolean {
    const pending = this.pendingQuestions.get(questionId)
    if (!pending) {
      log.info(`respondToQuestion: no pending request for ${questionId}`)
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

import type { AgentId, IpcContext, PermissionMode, ReasoningEffort, SessionStatus } from '@solus/contracts/types'
import { worktreeProjectRoot } from '@solus/contracts/types'
import type { ExecutionPreferences, PersonalSettings } from '@solus/contracts/settings'

/**
 * The context a native conversation sends with each call. The host reads the
 * session, the run, and the person's instructions from it; nothing here is a
 * tab. Window-only settings (fonts, theme) are fixed values the host ignores
 * for a run.
 */

export interface ConversationRun {
  sessionId: string
  agentSessionId: string | null
  provider: AgentId
  status: SessionStatus
  workingDirectory: string
  preferredModel: string | null
  reasoningEffort: ReasoningEffort
  /** Always the model's window: a resume without it drops to the provider default. */
  contextWindow: number | null
  /** Codex fast mode; always false for a model without it. */
  fastMode: boolean
  permissionMode: PermissionMode
  title: string | null
  /** The organization this device works in; the host assigns an unassigned session to it once. */
  organizationId: string | null
}

/** The person's settings a new run starts from (plans/018: personal, not the host's). */
export type RunSettings = Pick<PersonalSettings, 'defaultPermissionMode' | 'defaultModels' | 'modelOptionsByProvider'>

export const DEFAULT_RUN_SETTINGS: RunSettings = {
  defaultPermissionMode: 'full-access',
  defaultModels: {},
  modelOptionsByProvider: {},
}

/** `executionPreferences` are the person's preferences the host runs this work with (plans/018 §6). */
export function conversationContext(run: ConversationRun, settings: RunSettings, executionPreferences: ExecutionPreferences): IpcContext {
  return {
    session: {
      sessionId: run.sessionId,
      provider: run.provider,
      agentSessionId: run.agentSessionId,
      status: run.status,
      workingDirectory: run.workingDirectory,
      projectPath: worktreeProjectRoot(run.workingDirectory),
      additionalDirs: [],
      preferredModel: run.preferredModel,
      reasoningEffort: run.reasoningEffort,
      contextWindow: run.contextWindow,
      fastMode: run.fastMode,
      permissionMode: run.permissionMode,
      gitContext: null,
      worktreeBaseBranch: null,
      sessionChangedFiles: [],
      readOnlyReason: null,
      title: run.title,
      organizationId: run.organizationId ?? undefined,
    },
    settings: {
      fallbackTerminal: null,
      activeAgent: run.provider,
      reviewAgent: null,
      reviewModel: null,
      reviewReasoning: null,
      reviewGuideInstructions: '',
      reviewWarmingEnabled: false,
      executionPreferences,
    },
    statusBar: {
      workingDirectory: run.workingDirectory,
      activeAgent: run.provider,
      permissionMode: run.permissionMode,
      model: run.preferredModel ?? '',
      reasoningEffort: run.reasoningEffort,
      defaultReasoningEffort: run.reasoningEffort,
      reasoningLevels: [],
      supportsFastMode: false,
      fastMode: run.fastMode,
      contextWindows: run.contextWindow ? [run.contextWindow] : [],
    },
  }
}

/**
 * The context of a call about a project rather than a session: its pull
 * requests and files. An empty `projectPath` asks about the host itself, which
 * answers with its default git provider. No session runs from it.
 */
export function projectContext(projectPath: string, organizationId: string | null): IpcContext {
  return conversationContext({
    sessionId: '',
    agentSessionId: null,
    provider: 'claude-code',
    status: 'idle',
    workingDirectory: projectPath,
    preferredModel: null,
    reasoningEffort: 'medium',
    contextWindow: null,
    fastMode: false,
    permissionMode: 'supervised',
    title: null,
    organizationId,
  }, DEFAULT_RUN_SETTINGS, {})
}

/** Approving a plan runs it with the host's default mode; a plan mode would only plan again. */
export function implementationMode(defaultMode: PermissionMode): PermissionMode {
  return defaultMode === 'plan' ? 'full-access' : defaultMode
}

/** The prompt that starts an approved plan, as the desktop client writes it. */
export function implementPlanPrompt(plan: { planId: string; agentSessionId: string; planToolUseId: string; content: string }, note: string): string {
  const params = new URLSearchParams({ planId: plan.planId, sessionId: plan.agentSessionId, planToolUseId: plan.planToolUseId, status: 'accepted' })
  const title = planTitle(plan.content).replaceAll('[', '\\[').replaceAll(']', '\\]')
  let message = `Implement this plan: [${title}](plan://ref?${params})`
  if (note.trim()) message += `\n\nNotes:\n${note.trim()}`
  return message
}

export function revisePlanPrompt(comment: string): string {
  return `Please revise the plan with these comments:\n\n${comment.trim()}`
}

/** The plan's title by the desktop plan store's rule (`plan.store.svelte.ts`). */
export function planTitle(content: string): string {
  const match = content.match(/^#{1,2}\s+(.+)$/m)
  if (match?.[1]) return match[1].trim().slice(0, 120)
  const firstLine = content.split(/\r?\n/).find((line) => line.trim().length > 0)
  return (firstLine ?? '').trim().slice(0, 60) || 'Untitled plan'
}

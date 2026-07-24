import type EventEmitter from 'events'
import type {
  AgentId,
  AgentMetadata,
  EnrichedError,
  IpcContext,
  NormalizedEvent,
  PlanDescriptor,
  PluginCommandsResult,
  PromptOptions,
  SessionMeta,
  SessionRunInput,
  ThreadGoal,
  ThreadGoalSetRequest,
} from '../../shared/types'
import type { SessionLoadMessage, SessionPreviewResult } from '../../shared/session-history'

export interface PermissionResponder {
  getPendingInfo(questionId: string): { toolName: string; sessionId: string | null } | undefined
  respondToPermission(questionId: string, decision: string, updatedPayload?: string): boolean
  respondToQuestion(questionId: string, answers: Record<string, string>): boolean
  clearPendingForSession(sessionId: string): void
  setCurrentSessionId(sessionId: string): void
}

export interface RunHandle {
  sessionId: string | null
  /** Attached by ControlPlane for pre-session-init UI routing. */
  sourceTabId?: string
  startedAt: number
  toolCallCount: number
  sawPermissionRequest: boolean
  permissionDenials: Array<{ tool_name: string; tool_use_id: string }>
  abortController: AbortController
  /** Promise that settles when the run completes. Set up by the backend in startRun. */
  runPromise: Promise<void>
  /** Final assistant result reported by task_complete, when the provider supplies it. */
  resultText?: string
  _resolveRun: () => void
  _rejectRun: (err: Error) => void
}

export interface BackendEvents {
  normalized: (sessionId: string | null, event: NormalizedEvent) => void
  exit: (sessionId: string | null, code: number | null, signal: string | null) => void
  error: (sessionId: string | null, err: Error) => void
}

/**
 * Session-tied runtime contract implemented by each agent provider.
 * ControlPlane depends only on this surface — backends swap without
 * touching tab lifecycle, queueing, or worktree logic.
 */
export interface AgentBackend extends EventEmitter {
  readonly id: AgentId
  readonly metadata: AgentMetadata

  startRun(input: SessionRunInput, options: PromptOptions): RunHandle
  cancelSession(sessionId: string): boolean
  isSessionRunning(sessionId: string): boolean
  getSessionHandle(sessionId: string): RunHandle | undefined
  /** Runs that haven't received session_init yet (pre-session_init window). */
  getPendingHandles(): RunHandle[]
  getEnrichedError(sessionId: string | null, exitCode: number | null): EnrichedError
  listSessions(projectPath: string, onBatch?: (sessions: SessionMeta[]) => void, limit?: number): Promise<SessionMeta[]>
  /** When `limit` is set, returns only the most recent `limit` messages (windowed load for fast hydration). */
  loadSession(sessionId: string, projectPath?: string, limit?: number): Promise<SessionLoadMessage[]>
  loadSessionPreview?(sessionId: string, projectPath?: string): Promise<SessionPreviewResult>
  listPlans(projectPath: string | undefined, allProjects: boolean): Promise<PlanDescriptor[]>
  loadPlanContent(sessionId: string, projectPath: string, planToolUseId: string): Promise<string | null>
  getThreadGoal?(threadId: string): Promise<ThreadGoal | null>
  setThreadGoal?(request: ThreadGoalSetRequest): Promise<ThreadGoal>
  clearThreadGoal?(threadId: string): Promise<boolean>
  /** Filesystem plugin/skill commands, plus SDK built-in commands when `ctx` is given. */
  listPluginCommands(workingDirectory: string, ctx?: IpcContext): Promise<PluginCommandsResult>
  /** Invalidates cached plugin/skill commands after an external install. */
  refreshPluginCommands(): Promise<void>
  /** Incrementally refreshes durable session metadata when the provider supports it. */
  refreshSessionIndex?(): Promise<void>

  shutdown?(): void
  rewindFiles?(sessionId: string, checkpointId: string, projectPath: string): Promise<void>
  readonly permissions: PermissionResponder
}

import type { Session, Tab, Prompt, ModelConfig, RunConfig } from '../../../shared/types'
import { uuid } from '../../../shared/uuid'
import type { SettingsContext } from '../app/settings.context.svelte'
import { LOCAL_SERVER_ID } from '../../../client-core/server-registry'

export function makePrompt(overrides?: Partial<Prompt>): Prompt {
  return { text: '', attachments: [], planRefs: [], workRefs: [], sessionRefs: [], savedPromptId: null, ...overrides }
}

export function makeRunConfig(overrides?: Partial<RunConfig>): RunConfig {
  return {
    workingDirectory: '~',
    gitContext: null,
    worktreeBaseBranch: null,
    worktreeRequired: false,
    modelConfig: { modelId: null, reasoningEffort: 'high', contextWindow: null, fastMode: false } as ModelConfig,
    permissionMode: 'auto',
    provider: null,
    serverId: LOCAL_SERVER_ID,
    sessionSkills: [],
    pendingHostDispatch: null,
    ...overrides,
  }
}

export function makeSession(
  settings: SettingsContext,
  overrides?: Partial<Omit<Session, 'run'>> & { run?: Partial<RunConfig> },
): Session {
  const { run, ...rest } = overrides ?? {}
  return {
    id: uuid(),
    run: makeRunConfig(run),
    agentSessionId: null,
    status: 'idle',
    messages: [],
    currentActivity: '',
    currentTurnStart: null,
    currentTurnStartedAt: null,
    isStreamingText: false,
    isReconnecting: false,
    permissionQueue: [],
    questionQueue: [],
    permissionDenied: null,
    outboundPrompts: [],
    rateLimitInfo: null,
    rateLimitStrategy: settings.rateLimitBehavior,
    lastResult: null,
    contextUsage: null,
    runUsage: null,
    latestCheckpointId: null,
    retryAttempt: 1,
    terminalFailure: null,
    sessionModel: null,
    pluginCommands: { global: [], project: [] },
    progress: null,
    goal: null,
    pendingGoalObjective: null,
    statusCard: null,
    sessionChangedFiles: [],
    projectGroupPath: null,
    additionalDirs: [],
    readOnlyReason: null,
    loadingHistory: false,
    historyTruncated: false,
    forkedFromSessionId: null,
    forked: false,
    boundWorkId: null,
    pendingTaskId: null,
    pendingParentTaskId: null,
    taskCreationDisabled: false,
    prReview: null,
    ...rest,
  }
}

export function makeTab(sessionId: string, overrides?: Partial<Tab>): Tab {
  return {
    id: uuid(),
    sessionId,
    title: 'New Tab',
    titleCustom: false,
    hasUnread: false,
    input: makePrompt(),
    diffComments: [],
    diffGeneralComment: '',
    diffCommentDraft: null,
    ...overrides,
  }
}

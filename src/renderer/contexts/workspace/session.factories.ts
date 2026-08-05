import type { Session, Tab, InputState, ModelConfig } from '../../../shared/types'
import { uuid } from '../../../shared/uuid'
import type { SettingsContext } from '../app/settings.context.svelte'
import { LOCAL_SERVER_ID } from '../../../client-core/server-registry'

export function makeInputState(overrides?: Partial<InputState>): InputState {
  return { text: '', attachments: [], planRefs: [], workRefs: [], sessionRefs: [], savedPromptId: null, ...overrides }
}

export function makeSession(settings: SettingsContext, overrides?: Partial<Session>): Session {
  return {
    id: uuid(),
    serverId: LOCAL_SERVER_ID,
    agentSessionId: null,
    provider: null,
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
    sessionSkills: [],
    pluginCommands: { global: [], project: [] },
    progress: null,
    goal: null,
    pendingGoalObjective: null,
    statusCard: null,
    pendingHostDispatch: null,
    sessionChangedFiles: [],
    gitContext: null,
    workingDirectory: '~',
    projectGroupPath: null,
    additionalDirs: [],
    modelConfig: { modelId: null, reasoningEffort: 'high', contextWindow: null, fastMode: false } as ModelConfig,
    permissionMode: 'auto',
    worktreeBaseBranch: null,
    worktreeRequired: false,
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
    ...overrides,
  }
}

export function makeTab(sessionId: string, overrides?: Partial<Tab>): Tab {
  return {
    id: uuid(),
    sessionId,
    title: 'New Tab',
    titleCustom: false,
    hasUnread: false,
    input: makeInputState(),
    diffComments: [],
    diffGeneralComment: '',
    diffCommentDraft: null,
    ...overrides,
  }
}

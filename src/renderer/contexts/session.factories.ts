import type { Session, Tab, InputState, ModelConfig } from '../../shared/types'
import { uuid } from '../../shared/uuid'
import type { SettingsContext } from './settings.context.svelte'

export function makeInputState(overrides?: Partial<InputState>): InputState {
  return { text: '', attachments: [], planRefs: [], workRefs: [], ...overrides }
}

export function makeSession(settings: SettingsContext, overrides?: Partial<Session>): Session {
  return {
    id: uuid(),
    agentSessionId: null,
    provider: null,
    status: 'idle',
    messages: [],
    currentActivity: '',
    isStreamingText: false,
    isReconnecting: false,
    permissionQueue: [],
    questionQueue: [],
    permissionDenied: null,
    serverQueuedPrompts: [],
    rateLimitInfo: null,
    rateLimitStrategy: settings.rateLimitBehavior,
    lastResult: null,
    sessionUsage: null,
    latestCheckpointId: null,
    sessionModel: null,
    sessionSkills: [],
    pluginCommands: { global: [], project: [] },
    progress: null,
    statusCard: null,
    sessionChangedFiles: [],
    gitContext: null,
    workingDirectory: '~',
    additionalDirs: [],
    modelConfig: { modelId: null, reasoningEffort: 'high', contextWindow: null, fastMode: false } as ModelConfig,
    permissionMode: 'auto',
    worktreeBaseBranch: null,
    readOnlyReason: null,
    loadingHistory: false,
    historyTruncated: false,
    forkedFromSessionId: null,
    forked: false,
    boundWorkId: null,
    boundTaskId: null,
    prReview: null,
    ...overrides,
  }
}

export function makeTab(sessionId: string, overrides?: Partial<Tab>): Tab {
  return {
    id: uuid(),
    sessionId,
    title: 'New Tab',
    hasUnread: false,
    input: makeInputState(),
    diffComments: [],
    diffGeneralComment: '',
    diffCommentDraft: null,
    ...overrides,
  }
}

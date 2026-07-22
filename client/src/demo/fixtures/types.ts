import type { SessionLoadMessage } from '../../../../src/shared/session-history'
import type {
  Automation,
  AutomationRun,
  NormalizedEvent,
  PlanAnnotations,
  PlanDescriptor,
  SessionMeta,
  StartInfo,
  WorkAnnotations,
  WorkMeta,
  WorkPrevious,
} from '../../../../src/shared/types'
import type {
  PullRequestOverview,
  PullRequestSummary,
  ReviewThread,
} from '../../../../src/shared/providers'
import type {
  Task,
  TaskCommentData,
  TaskListResult,
  TaskSessionLink,
} from '../../../../src/shared/task-types'
import type { ReviewGuide } from '../../../../src/shared/review'
import type {
  ChangedFileStat,
  GitProjectStatus,
  TurnSnapshot,
} from '../../../../src/shared/git-types'
import type { RpcInvokeMethod, RpcTopic } from '../../../../src/shared/rpc'
import type { PersistedTabs } from '../../../../src/renderer/contexts/tab-persistence'

export const DEMO_PROJECT = '/home/demo/acme'
export const DEMO_INSTALLATION_ID = 'demo'

export interface DemoFixtures {
  startInfo: StartInfo
  persistedTabs: PersistedTabs
  sessions: Array<{ meta: SessionMeta; messages: SessionLoadMessage[] }>
  plans: Array<{
    descriptor: PlanDescriptor
    content: string
    annotations: PlanAnnotations
  }>
  works: Array<{
    meta: WorkMeta & { id: string }
    content: string
    annotations?: WorkAnnotations
    previous?: WorkPrevious
  }>
  pr: {
    list: PullRequestSummary[]
    overview: PullRequestOverview
    changedFiles: ChangedFileStat[]
    threads: ReviewThread[]
    guide: ReviewGuide
    filePatches: Record<string, string>
  }
  tasks: {
    list: TaskListResult
    details: Record<string, Task>
    comments: Record<string, TaskCommentData[]>
    sessions: Record<string, TaskSessionLink[]>
  }
  automations: {
    list: Automation[]
    runs: Record<string, AutomationRun[]>
  }
  diffs: Record<
    string,
    {
      patch: string
      stats: ChangedFileStat[]
      turnSnapshots: TurnSnapshot[]
      changedFiles: string[]
    }
  >
  gitStatus: GitProjectStatus
  replayScript: ReplayStep[]
  files: {
    root: string
    files: string[]
    contents: Record<string, string>
  }
}

export interface ReplayStep {
  delayMs: number
  tabId: string
  event: NormalizedEvent
}

export interface DemoServer {
  register(
    method: RpcInvokeMethod,
    fn: (args: unknown[]) => unknown | Promise<unknown>,
  ): void
  broadcast(topic: RpcTopic, ...payload: unknown[]): void
}

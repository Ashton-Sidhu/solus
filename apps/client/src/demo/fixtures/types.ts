import type { SessionLoadMessage } from '@solus/contracts/session-history'
import type {
  Automation,
  AutomationRun,
  PlanAnnotations,
  PlanDescriptor,
  SessionMeta,
  StartInfo,
  WorkAnnotations,
  WorkMeta,
  WorkPrevious,
  WireNormalizedEvent,
} from '@solus/contracts/types'
import type {
  PullRequestOverview,
  PullRequestSummary,
  ReviewThread,
} from '@solus/contracts/providers'
import type {
  Task,
  TaskCommentData,
  TaskListResult,
  TaskSessionLink,
} from '@solus/contracts/task-types'
import type { ReviewGuide } from '@solus/contracts/review'
import type {
  ChangedFileStat,
  GitState,
  TurnSnapshot,
} from '@solus/contracts/git-types'
import type { RpcInvokeMethod } from '@solus/contracts/rpc'
import type { HostEventMap, HostEventName } from '@solus/contracts/host-events'
import type { PersistedTabs } from '@solus/workspace-ui/contexts/workspace/tab-persistence'

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
  /** Keyed by Solus session id (`IpcContext.session.sessionId`, the persisted
   *  tab's `sessionId`) — not the tab id and not the agent session id. */
  diffs: Record<
    string,
    {
      patch: string
      stats: ChangedFileStat[]
      turnSnapshots: TurnSnapshot[]
      changedFiles: string[]
    }
  >
  gitStatus: GitState
  replayScript: ReplayStep[]
  files: {
    root: string
    files: string[]
    contents: Record<string, string>
  }
}

export interface ReplayStep {
  delayMs: number
  sessionId: string
  event: WireNormalizedEvent
}

export interface DemoServer {
  register(
    method: RpcInvokeMethod,
    fn: (args: unknown[]) => unknown | Promise<unknown>,
  ): void
  broadcast<K extends HostEventName>(type: K, payload: HostEventMap[K]): void
}

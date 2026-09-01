import type { SolusAPI } from '@solus/contracts/host-api'
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
  PullRequest,
  ReviewThread,
} from '@solus/contracts/providers'
import type {
  Task,
  TaskCommentData,
  TaskLink,
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
/** The login the visitor is signed in as. It is the author of the demo's pull
 *  request and of the replies in its review threads, so the surfaces that ask
 *  "is this mine?" — comment authorship, the review queue — answer the same. */
export const DEMO_VIEWER = 'acme-dev'

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
    list: PullRequest[]
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
    /** Docs, plans, PRs and automations already attached to a task. */
    links: Record<string, TaskLink[]>
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

/**
 * Everything the Solus RPC surface can resolve to. The contract has no per-method
 * result map, so the demo backend answers with the union of all method results and
 * each caller narrows it by the method it invoked — the same shape the real
 * WebSocket transport uses.
 */
export type DemoRpcResult = Awaited<ReturnType<SolusAPI[RpcInvokeMethod]>>

export type RpcHandler = (args: unknown[]) => DemoRpcResult | Promise<DemoRpcResult>

export interface DemoServer {
  register(method: RpcInvokeMethod, fn: RpcHandler): void
  broadcast<K extends HostEventName>(type: K, payload: HostEventMap[K]): void
}

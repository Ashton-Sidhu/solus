import type {
  WorkspaceCreateTask, WorkspaceUpdateTask, WorkspaceTask, WorkspaceTaskPage, WorkspaceTaskQuery,
  WorkspaceCreateWork, WorkspaceImportWork, WorkspacePublishWork, WorkspaceRequestWorkReview, WorkspaceWorkReview, WorkspaceWorkUpstream, WorkspaceUpdateWork, WorkspaceWork, WorkspaceWorkPage, WorkspaceWorkQuery, WorkspaceWorkSearchQuery, WorkspaceWorkSearchResult,
  WorkspaceSession, WorkspaceSessionAdmission, WorkspaceSessionAdmissionRequest, WorkspaceSessionPage, WorkspaceSessionQuery, WorkspaceSessionSearchQuery, WorkspaceSessionSearchResult, WorkspacePageQuery, WorkspaceTranscriptPage,
  WorkspaceInsight, WorkspaceInsightPage, WorkspaceInsightQuery,
  WorkspaceActivityList, WorkspaceActivityQuery, WorkspaceMyActivityQuery,
} from '@solus/contracts/solus-api'
import type { WorkspaceRequestContext } from '../../admission/workspace-credentials'

/** Transport-independent operations: HTTP and admitted in-process tools share these rules. */
export interface WorkspaceOperations {
  listTasks(context: WorkspaceRequestContext, query: WorkspaceTaskQuery): Promise<WorkspaceTaskPage>
  getTask(context: WorkspaceRequestContext, taskId: string): Promise<WorkspaceTask>
  createTask(context: WorkspaceRequestContext, input: WorkspaceCreateTask, key: string): Promise<WorkspaceTask>
  updateTask(context: WorkspaceRequestContext, taskId: string, input: WorkspaceUpdateTask, version: string): Promise<WorkspaceTask>
  deleteTask(context: WorkspaceRequestContext, taskId: string, version: string): Promise<void>
  listWorks(context: WorkspaceRequestContext, query: WorkspaceWorkQuery): Promise<WorkspaceWorkPage>
  searchWorks(context: WorkspaceRequestContext, query: WorkspaceWorkSearchQuery): Promise<WorkspaceWorkSearchResult>
  importWork(context: WorkspaceRequestContext, input: WorkspaceImportWork, key: string): Promise<WorkspaceWork>
  publishWork(context: WorkspaceRequestContext, workId: string, input: WorkspacePublishWork): Promise<WorkspaceWorkUpstream>
  pullWorkUpstream(context: WorkspaceRequestContext, workId: string): Promise<WorkspaceWorkUpstream>
  requestWorkReview(context: WorkspaceRequestContext, workId: string, input: WorkspaceRequestWorkReview): Promise<WorkspaceWorkReview>
  getWorkVersion(context: WorkspaceRequestContext, workId: string): Promise<string>
  getWork(context: WorkspaceRequestContext, workId: string): Promise<WorkspaceWork>
  createWork(context: WorkspaceRequestContext, input: WorkspaceCreateWork, key: string): Promise<WorkspaceWork>
  updateWork(context: WorkspaceRequestContext, workId: string, input: WorkspaceUpdateWork, version: string): Promise<WorkspaceWork>
  deleteWork(context: WorkspaceRequestContext, workId: string, version: string): Promise<void>
  listSessions(context: WorkspaceRequestContext, query: WorkspaceSessionQuery): Promise<WorkspaceSessionPage>
  searchSessions(context: WorkspaceRequestContext, query: WorkspaceSessionSearchQuery): Promise<WorkspaceSessionSearchResult>
  admitSession(context: WorkspaceRequestContext, input: WorkspaceSessionAdmissionRequest): Promise<WorkspaceSessionAdmission>
  getSession(context: WorkspaceRequestContext, sessionId: string): Promise<WorkspaceSession>
  listSessionMessages(context: WorkspaceRequestContext, sessionId: string, query: WorkspacePageQuery): Promise<WorkspaceTranscriptPage>
  listInsights(context: WorkspaceRequestContext, query: WorkspaceInsightQuery): Promise<WorkspaceInsightPage>
  getInsight(context: WorkspaceRequestContext, insightId: string): Promise<WorkspaceInsight>
  listTaskActivity(context: WorkspaceRequestContext, taskId: string, query: WorkspaceActivityQuery): Promise<WorkspaceActivityList>
  listWorkActivity(context: WorkspaceRequestContext, workId: string, query: WorkspaceActivityQuery): Promise<WorkspaceActivityList>
  listSessionActivity(context: WorkspaceRequestContext, sessionId: string, query: WorkspaceActivityQuery): Promise<WorkspaceActivityList>
  listMyActivity(context: WorkspaceRequestContext, query: WorkspaceMyActivityQuery): Promise<WorkspaceActivityList>
}

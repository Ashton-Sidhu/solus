import type {
  WorkspaceCreateTask, WorkspaceCreateTaskComment, WorkspaceTaskComment, WorkspaceLink, WorkspaceLinkDelete, WorkspaceUpdateTask, WorkspaceTask, WorkspaceTaskPage, WorkspaceTaskQuery,
  WorkspaceCreateWork, WorkspaceImportWork, WorkspacePublishWork, WorkspaceRequestWorkReview, WorkspaceWorkReview, WorkspaceWorkUpstream, WorkspaceUpdateWork, WorkspaceWork, WorkspaceWorkPage, WorkspaceWorkQuery, WorkspaceWorkSearchQuery, WorkspaceWorkSearchResult,
  WorkspaceSession, WorkspaceSessionChanged, WorkspaceSessionPullRequestList, WorkspaceUpdateSession, WorkspaceSessionAdmission, WorkspaceSessionAdmissionRequest, WorkspaceSessionPage, WorkspaceSessionQuery, WorkspaceSessionSearchQuery, WorkspaceSessionSearchResult, WorkspacePageQuery, WorkspaceTranscriptPage,
  WorkspaceInsight, WorkspaceInsightPage, WorkspaceInsightQuery, WorkspaceInsightTree,
  WorkspaceActivityList, WorkspaceActivityQuery, WorkspaceMyActivityQuery,
  WorkspaceNotificationArchived, WorkspaceNotificationPage, WorkspaceNotificationQuery, WorkspaceNotificationRead,
} from '@solus/contracts/solus-api'
import type { HubNotification, NotificationCount } from '@solus/contracts/notification-hub'
import type { WorkspaceRequestContext } from '../../admission/workspace-credentials'

/** Transport-independent operations: HTTP and admitted in-process tools share these rules. */
export interface WorkspaceOperations {
  listTasks(context: WorkspaceRequestContext, query: WorkspaceTaskQuery): Promise<WorkspaceTaskPage>
  getTask(context: WorkspaceRequestContext, taskId: string): Promise<WorkspaceTask>
  createTask(context: WorkspaceRequestContext, input: WorkspaceCreateTask, key: string): Promise<WorkspaceTask>
  updateTask(context: WorkspaceRequestContext, taskId: string, input: WorkspaceUpdateTask, version: string): Promise<WorkspaceTask>
  deleteTask(context: WorkspaceRequestContext, taskId: string, version: string): Promise<void>
  createTaskComment(context: WorkspaceRequestContext, taskId: string, input: WorkspaceCreateTaskComment, key: string): Promise<WorkspaceTaskComment>
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
  /** A prompt reached the session on its machine. */
  admitSessionTurn(context: WorkspaceRequestContext, sessionId: string): Promise<void>
  /** Settle a session for every person, or archive and snooze it in the caller's own list. */
  updateSession(context: WorkspaceRequestContext, sessionId: string, input: WorkspaceUpdateSession): Promise<WorkspaceSessionChanged>
  listSessionPullRequests(context: WorkspaceRequestContext, sessionId: string): Promise<WorkspaceSessionPullRequestList>
  /** Link a task or a session to another record; the same link again changes nothing. */
  putLink(context: WorkspaceRequestContext, input: WorkspaceLink): Promise<void>
  deleteLink(context: WorkspaceRequestContext, input: WorkspaceLinkDelete): Promise<void>
  listSessionMessages(context: WorkspaceRequestContext, sessionId: string, query: WorkspacePageQuery): Promise<WorkspaceTranscriptPage>
  listInsights(context: WorkspaceRequestContext, query: WorkspaceInsightQuery): Promise<WorkspaceInsightPage>
  getInsight(context: WorkspaceRequestContext, insightId: string): Promise<WorkspaceInsight>
  getInsightSpans(context: WorkspaceRequestContext, insightId: string): Promise<WorkspaceInsightTree>
  listTaskActivity(context: WorkspaceRequestContext, taskId: string, query: WorkspaceActivityQuery): Promise<WorkspaceActivityList>
  listWorkActivity(context: WorkspaceRequestContext, workId: string, query: WorkspaceActivityQuery): Promise<WorkspaceActivityList>
  listSessionActivity(context: WorkspaceRequestContext, sessionId: string, query: WorkspaceActivityQuery): Promise<WorkspaceActivityList>
  listMyActivity(context: WorkspaceRequestContext, query: WorkspaceMyActivityQuery): Promise<WorkspaceActivityList>
  listMyNotifications(context: WorkspaceRequestContext, query: WorkspaceNotificationQuery): Promise<WorkspaceNotificationPage>
  countMyNotifications(context: WorkspaceRequestContext): Promise<NotificationCount>
  setMyNotificationRead(context: WorkspaceRequestContext, notificationId: string, input: WorkspaceNotificationRead): Promise<HubNotification>
  setMyNotificationArchived(context: WorkspaceRequestContext, notificationId: string, input: WorkspaceNotificationArchived): Promise<HubNotification>
}

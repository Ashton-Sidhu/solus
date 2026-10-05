import { withWorkspaceBudget } from './request-budget'
import type { ShareManager } from '../../sharing/share-manager'
import { TaskApiOperations } from '../tasks/api-operations'
import { WorkApiOperations } from '../works/api-operations'
import { SessionApiOperations } from '../sessions/api-operations'
import { readInsight, readInsightPage, readInsightTree } from '../insights/api-operations'
import { ActivityApiOperations } from '../activity/api-operations'
import { NotificationApiOperations } from '../notifications/api-operations'
import type { WorkspaceOperations } from './operations'

/** The same domain operations serve HTTP and admitted agent tools. No execution runtime is needed. */
export function createWorkspaceOperations(shares: ShareManager): WorkspaceOperations {
  const tasks = new TaskApiOperations(shares)
  const works = new WorkApiOperations(shares)
  const sessions = new SessionApiOperations(shares)
  const activity = new ActivityApiOperations(shares)
  const notifications = new NotificationApiOperations(shares)
  return {
    listTasks: withWorkspaceBudget((context, query) => tasks.list(context, query)),
    getTask: withWorkspaceBudget((context, taskId) => tasks.get(context, taskId)),
    createTask: withWorkspaceBudget((context, input, key) => tasks.create(context, input, key)),
    updateTask: withWorkspaceBudget((context, taskId, input, version) => tasks.update(context, taskId, input, version)),
    deleteTask: withWorkspaceBudget((context, taskId, version) => tasks.delete(context, taskId, version)),
    listWorks: withWorkspaceBudget((context, query) => works.list(context, query)),
    searchWorks: withWorkspaceBudget((context, query) => works.search(context, query)),
    importWork: withWorkspaceBudget((context, input, key) => works.import(context, input, key)),
    publishWork: withWorkspaceBudget((context, workId, input) => works.publish(context, workId, input)),
    pullWorkUpstream: withWorkspaceBudget((context, workId) => works.pullUpstream(context, workId)),
    requestWorkReview: withWorkspaceBudget((context, workId, input) => works.requestReview(context, workId, input)),
    getWorkVersion: withWorkspaceBudget((context, workId) => works.version(context, workId)),
    getWork: withWorkspaceBudget((context, workId) => works.get(context, workId)),
    createWork: withWorkspaceBudget((context, input, key) => works.create(context, input, key)),
    updateWork: withWorkspaceBudget((context, workId, input, version) => works.update(context, workId, input, version)),
    deleteWork: withWorkspaceBudget((context, workId, version) => works.delete(context, workId, version)),
    listSessions: withWorkspaceBudget((context, query) => sessions.list(context, query)),
    searchSessions: withWorkspaceBudget((context, query) => sessions.search(context, query)),
    admitSession: withWorkspaceBudget((context, input) => sessions.admit(context, input)),
    getSession: withWorkspaceBudget((context, sessionId) => sessions.get(context, sessionId)),
    listSessionMessages: withWorkspaceBudget((context, sessionId, query) => sessions.messages(context, sessionId, query)),
    listInsights: withWorkspaceBudget((context, query) => readInsightPage(context, query)),
    getInsight: withWorkspaceBudget((context, insightId) => readInsight(context, insightId)),
    getInsightSpans: withWorkspaceBudget((context, insightId) => readInsightTree(context, insightId)),
    listTaskActivity: withWorkspaceBudget((context, taskId, query) => activity.forRecord(context, { kind: 'task', id: taskId }, query)),
    listWorkActivity: withWorkspaceBudget((context, workId, query) => activity.forRecord(context, { kind: 'work', id: workId }, query)),
    listSessionActivity: withWorkspaceBudget((context, sessionId, query) => activity.forRecord(context, { kind: 'session', id: sessionId }, query)),
    listMyActivity: withWorkspaceBudget((context, query) => activity.namingCaller(context, query)),
    listMyNotifications: withWorkspaceBudget((context, query) => notifications.list(context, query)),
    countMyNotifications: withWorkspaceBudget((context) => notifications.count(context)),
    setMyNotificationRead: withWorkspaceBudget((context, notificationId, input) => notifications.setRead(context, notificationId, input)),
    setMyNotificationArchived: withWorkspaceBudget((context, notificationId, input) => notifications.setArchived(context, notificationId, input)),
  }
}

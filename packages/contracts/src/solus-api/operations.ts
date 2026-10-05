import { z } from 'zod'
import * as schemas from './schemas'
import * as queries from './queries'

const empty = z.strictObject({})
/** Runtime validation, route discovery, and OpenAPI all use this registry. */
export const solusApiOperations = {
  exchangeCredential: { method: 'post', path: '/auth/session', query: empty, body: schemas.workspaceAuthSessionRequestSchema, response: schemas.workspaceAuthSessionSchema, status: 200 },
  capabilities: { method: 'get', path: '/capabilities', query: empty, response: schemas.workspaceCapabilitiesSchema, status: 200 },
  openApi: { method: 'get', path: '/openapi.json', query: empty, status: 200 },
  listTasks: { method: 'get', path: '/tasks', scope: 'tasks:read', query: queries.workspaceTaskQuerySchema, response: schemas.workspaceTaskPageSchema, status: 200 },
  getTask: { method: 'get', path: '/tasks/:taskId', scope: 'tasks:read', query: empty, response: schemas.workspaceTaskSchema, status: 200 },
  listTaskActivity: { method: 'get', path: '/tasks/:taskId/activity', scope: 'tasks:read', query: queries.workspaceActivityQuerySchema, response: schemas.workspaceActivityListSchema, status: 200 },
  createTask: { method: 'post', path: '/tasks', scope: 'tasks:write', query: empty, body: schemas.workspaceCreateTaskSchema, response: schemas.workspaceTaskSchema, status: 201, idempotent: true },
  updateTask: { method: 'patch', path: '/tasks/:taskId', scope: 'tasks:write', query: empty, body: schemas.workspaceUpdateTaskSchema, response: schemas.workspaceTaskSchema, status: 200, conditional: true },
  deleteTask: { method: 'delete', path: '/tasks/:taskId', scope: 'tasks:write', query: empty, status: 204, conditional: true },
  listWorks: { method: 'get', path: '/works', scope: 'works:read', query: queries.workspaceWorkQuerySchema, response: schemas.workspaceWorkPageSchema, status: 200 },
  publishWork: { method: 'post', path: '/works/:workId/publish', scope: 'works:write', query: empty, body: schemas.workspacePublishWorkSchema, response: schemas.workspaceWorkUpstreamSchema, status: 200 },
  pullWorkUpstream: { method: 'post', path: '/works/:workId/pull', scope: 'works:write', query: empty, body: empty, response: schemas.workspaceWorkUpstreamSchema, status: 200 },
  requestWorkReview: { method: 'post', path: '/works/:workId/review-requests', scope: 'works:write', query: empty, body: schemas.workspaceRequestWorkReviewSchema, response: schemas.workspaceWorkReviewSchema, status: 200 },
  importWork: { method: 'post', path: '/works/import', scope: 'works:write', query: empty, body: schemas.workspaceImportWorkSchema, response: schemas.workspaceWorkSchema, status: 201, idempotent: true },
  searchWorks: { method: 'get', path: '/works/search', scope: 'works:read', query: queries.workspaceWorkSearchQuerySchema, response: schemas.workspaceWorkSearchResultSchema, status: 200 },
  getWork: { method: 'get', path: '/works/:workId', scope: 'works:read', query: empty, response: schemas.workspaceWorkSchema, status: 200 },
  listWorkActivity: { method: 'get', path: '/works/:workId/activity', scope: 'works:read', query: queries.workspaceActivityQuerySchema, response: schemas.workspaceActivityListSchema, status: 200 },
  createWork: { method: 'post', path: '/works', scope: 'works:write', query: empty, body: schemas.workspaceCreateWorkSchema, response: schemas.workspaceWorkSchema, status: 201, idempotent: true },
  updateWork: { method: 'patch', path: '/works/:workId', scope: 'works:write', query: empty, body: schemas.workspaceUpdateWorkSchema, response: schemas.workspaceWorkSchema, status: 200, conditional: true },
  deleteWork: { method: 'delete', path: '/works/:workId', scope: 'works:write', query: empty, status: 204, conditional: true },
  listSessions: { method: 'get', path: '/sessions', scope: 'sessions:read', query: queries.workspaceSessionQuerySchema, response: schemas.workspaceSessionPageSchema, status: 200 },
  searchSessions: { method: 'get', path: '/sessions/search', scope: 'sessions:read', query: queries.workspaceSessionSearchQuerySchema, response: schemas.workspaceSessionSearchResultSchema, status: 200 },
  getSession: { method: 'get', path: '/sessions/:sessionId', scope: 'sessions:read', query: empty, response: schemas.workspaceSessionSchema, status: 200 },
  admitSession: { method: 'post', path: '/session-admissions', scope: 'sessions:admit', query: empty, body: schemas.workspaceSessionAdmissionRequestSchema, response: schemas.workspaceSessionAdmissionSchema, status: 201 },
  listSessionMessages: { method: 'get', path: '/sessions/:sessionId/messages', scope: 'sessions:read', query: queries.workspacePageQuerySchema, response: schemas.workspaceTranscriptPageSchema, status: 200 },
  listSessionActivity: { method: 'get', path: '/sessions/:sessionId/activity', scope: 'sessions:read', query: queries.workspaceActivityQuerySchema, response: schemas.workspaceActivityListSchema, status: 200 },
  /** Activity that names the caller, from every record kind the credential may read; each row's record is checked. */
  listMyActivity: { method: 'get', path: '/me/activity', query: queries.workspaceMyActivityQuerySchema, response: schemas.workspaceActivityListSchema, status: 200 },
  /** The caller's notifications at this home (plans/015-notifications-hub.md). Every row's record is checked. */
  listMyNotifications: { method: 'get', path: '/me/notifications', query: queries.workspaceNotificationQuerySchema, response: schemas.workspaceNotificationPageSchema, status: 200 },
  countMyNotifications: { method: 'get', path: '/me/notifications/count', query: empty, response: schemas.workspaceNotificationCountSchema, status: 200 },
  setMyNotificationRead: { method: 'post', path: '/me/notifications/:notificationId/read', query: empty, body: schemas.workspaceNotificationReadSchema, response: schemas.workspaceNotificationSchema, status: 200 },
  setMyNotificationArchived: { method: 'post', path: '/me/notifications/:notificationId/archive', query: empty, body: schemas.workspaceNotificationArchivedSchema, response: schemas.workspaceNotificationSchema, status: 200 },
  listInsights: { method: 'get', path: '/insights', scope: 'insights:read', query: queries.workspaceInsightQuerySchema, response: schemas.workspaceInsightPageSchema, status: 200 },
  getInsight: { method: 'get', path: '/insights/:insightId', scope: 'insights:read', query: empty, response: schemas.workspaceInsightSchema, status: 200 },
  getInsightSpans: { method: 'get', path: '/insights/:insightId/spans', scope: 'insights:read', query: empty, response: schemas.workspaceInsightTreeSchema, status: 200 },
} as const
export type SolusApiOperation = keyof typeof solusApiOperations

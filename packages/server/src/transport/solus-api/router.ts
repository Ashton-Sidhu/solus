import { actorFor, ownerKeyOf } from '../../admission/actor'
import { withActorScope } from '../../execution/seats/acting-identity'
import { createLogger } from '../../logger'
import { randomUUID } from 'node:crypto'
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { solusApiOperations as routes, workspaceIdSchema, workspaceVersionSchema, type WorkspaceCapabilities } from '@solus/contracts/solus-api'
import { SolusApiError } from '../../admission/workspace-error'
import { SOLUS_API_ORGANIZATION_HEADER, solusApiRequestHeaders, solusApiRequestSchema, solusApiResponseOf, type SolusApiRequest, type SolusApiResponse } from '@solus/contracts/solus-api/request'
import type { Principal } from '../../admission/principal'
import type { WorkspaceAdmission, WorkspaceRequestContext } from '../../admission/workspace-credentials'
import type { WorkspaceOperations } from '../../data/workspace/operations'
import { WorkspaceRequestBudgets } from './limits'

const log = createLogger('server', 'solus-api')

/** Over HTTP, `Bindings` are the Node adapter's request and response; a caller cannot set `socketPrincipal`. */
interface ApiEnvironment { Bindings: { socketPrincipal?: Principal }; Variables: { authority: WorkspaceRequestContext; requestId: string } }
export type SolusApiRouter = Hono<ApiEnvironment>
type ApiContext = Context<ApiEnvironment>
interface SolusApiRouterOptions {
  admission: WorkspaceAdmission
  operations: WorkspaceOperations
  capabilities: WorkspaceCapabilities
  openApi: () => string
}

const TASK_BODY_BYTES = 4 * 1024 * 1024
const WORK_BODY_BYTES = 16 * 1024 * 1024

function bearer(c: ApiContext): string {
  const header = c.req.header('Authorization') ?? ''
  return header.startsWith('Bearer ') ? header.slice(7) : ''
}
function query<T extends z.ZodType>(c: ApiContext, schema: T): z.output<T> {
  if (Object.values(c.req.queries()).some(items => items.length !== 1)) throw new SolusApiError(400, 'INVALID_REQUEST', 'Duplicate query parameters are not allowed.')
  return schema.parse(c.req.query())
}
function version(c: ApiContext): string {
  const value = c.req.header('If-Match')
  if (!value || !/^"[^"\r\n]+"$/.test(value)) throw new SolusApiError(400, 'INVALID_REQUEST', 'A quoted If-Match resource version is required.')
  return workspaceVersionSchema.parse(value.slice(1, -1))
}
function idempotencyKey(c: ApiContext): string { return z.string().min(16).max(128).parse(c.req.header('Idempotency-Key')) }
function id(c: ApiContext, name: string): string { return workspaceIdSchema.parse(c.req.param(name)) }
function etag(c: ApiContext, value: string): void { c.header('ETag', JSON.stringify(value)) }
const limitBody = (maxSize: number) => bodyLimit({ maxSize, onError: () => { throw new SolusApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.') } })

async function body<T extends z.ZodType>(c: ApiContext, schema: T): Promise<z.output<T>> {
  if (!c.req.header('Content-Type')?.toLowerCase().startsWith('application/json')) throw new SolusApiError(400, 'INVALID_REQUEST', 'Content-Type must be application/json.')
  let json: unknown
  try { json = await c.req.json() }
  catch { throw new SolusApiError(400, 'INVALID_REQUEST', 'Invalid JSON body.') }
  return schema.parse(json)
}

/** Mounted at /v1. Resource calls never pass through the RPC dispatcher; operations enforce scope and access. */
export function createSolusApiRouter(options: SolusApiRouterOptions): SolusApiRouter {
  const app = new Hono<ApiEnvironment>()
  const { operations } = options
  const budgets = new WorkspaceRequestBudgets()

  app.use('*', async (c, next) => {
    c.set('requestId', randomUUID())
    c.header('X-Request-Id', c.get('requestId'))
    c.header('Cache-Control', 'no-store')
    await next()
  })
  app.onError((error, c) => {
    if (error instanceof z.ZodError) return c.json({ error: { code: 'INVALID_REQUEST', message: 'Invalid request.', requestId: c.get('requestId'), issues: error.issues.slice(0, 100).map(issue => ({ path: issue.path.map(String), message: issue.message })) } }, 400)
    if (error instanceof SolusApiError) {
      if (error.retryAfter) c.header('Retry-After', String(error.retryAfter))
      return c.json({ error: { code: error.code, message: error.message, requestId: c.get('requestId') } }, error.status)
    }
    log.error('workspace_request_failed', { requestId: c.get('requestId'), error: error instanceof Error ? error.message : String(error) })
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'The request could not be completed.', requestId: c.get('requestId') } }, 500)
  })
  app.notFound(c => c.json({ error: { code: 'NOT_FOUND', message: 'Resource not found.', requestId: c.get('requestId') } }, 404))

  // The one route that takes no credential is registered before the check below.
  app.get(routes.openApi.path, c => c.body(options.openApi(), 200, { 'Content-Type': 'application/json' }))

  app.use('*', async (c, next) => {
    // A socket request's authority is its socket's principal; an HTTP request's is its
    // bearer, in the organization the request names (plan simplify-auth-and-sync §4.2).
    const socketPrincipal = c.env?.socketPrincipal
    const authority = socketPrincipal
      ? await options.admission.socket(socketPrincipal)
      : await options.admission.bearer(bearer(c), c.req.header(SOLUS_API_ORGANIZATION_HEADER) || undefined)
    if (!authority) throw new SolusApiError(401, 'UNAUTHENTICATED', 'A valid API credential is required.')
    c.set('authority', authority)
    const actor = actorFor(authority.principal)
    const release = budgets.enter(ownerKeyOf(actor) ?? 'unowned')
    try { await withActorScope(actor, next) } finally { release() }
  })
  const authority = (c: ApiContext) => c.get('authority')

  app.get(routes.capabilities.path, c => { query(c, routes.capabilities.query); return c.json(options.capabilities) })

  app.get(routes.listTasks.path, async c => c.json(await operations.listTasks(authority(c), query(c, routes.listTasks.query))))
  app.get(routes.getTask.path, async c => {
    query(c, routes.getTask.query)
    const task = await operations.getTask(authority(c), id(c, 'taskId'))
    etag(c, task.version); return c.json(task)
  })
  app.post(routes.createTask.path, limitBody(TASK_BODY_BYTES), async c => {
    query(c, routes.createTask.query)
    const task = await operations.createTask(authority(c), await body(c, routes.createTask.body), idempotencyKey(c))
    c.header('Location', '/v1/tasks/' + encodeURIComponent(task.id)); etag(c, task.version); return c.json(task, 201)
  })
  app.patch(routes.updateTask.path, limitBody(TASK_BODY_BYTES), async c => {
    query(c, routes.updateTask.query)
    const task = await operations.updateTask(authority(c), id(c, 'taskId'), await body(c, routes.updateTask.body), version(c))
    etag(c, task.version); return c.json(task)
  })
  app.get(routes.listTaskActivity.path, async c => c.json(await operations.listTaskActivity(authority(c), id(c, 'taskId'), query(c, routes.listTaskActivity.query))))
  app.delete(routes.deleteTask.path, async c => { query(c, routes.deleteTask.query); await operations.deleteTask(authority(c), id(c, 'taskId'), version(c)); return c.body(null, 204) })
  app.post(routes.createTaskComment.path, limitBody(TASK_BODY_BYTES), async c => {
    query(c, routes.createTaskComment.query)
    return c.json(await operations.createTaskComment(authority(c), id(c, 'taskId'), await body(c, routes.createTaskComment.body), idempotencyKey(c)), 201)
  })
  app.put(routes.putLink.path, limitBody(16 * 1024), async c => {
    query(c, routes.putLink.query)
    await operations.putLink(authority(c), await body(c, routes.putLink.body)); return c.body(null, 204)
  })
  app.delete(routes.deleteLink.path, limitBody(16 * 1024), async c => {
    query(c, routes.deleteLink.query)
    await operations.deleteLink(authority(c), await body(c, routes.deleteLink.body)); return c.body(null, 204)
  })

  app.get(routes.listWorks.path, async c => c.json(await operations.listWorks(authority(c), query(c, routes.listWorks.query))))
  app.post(routes.importWork.path, limitBody(16 * 1024), async c => {
    query(c, routes.importWork.query)
    const work = await operations.importWork(authority(c), await body(c, routes.importWork.body), idempotencyKey(c))
    c.header('Location', '/v1/works/' + encodeURIComponent(work.id)); etag(c, work.version); return c.json(work, 201)
  })
  app.post(routes.publishWork.path, limitBody(16 * 1024), async c => {
    query(c, routes.publishWork.query)
    return c.json(await operations.publishWork(authority(c), id(c, 'workId'), await body(c, routes.publishWork.body)))
  })
  app.post(routes.pullWorkUpstream.path, limitBody(1024), async c => {
    query(c, routes.pullWorkUpstream.query)
    await body(c, routes.pullWorkUpstream.body)
    return c.json(await operations.pullWorkUpstream(authority(c), id(c, 'workId')))
  })
  app.post(routes.requestWorkReview.path, limitBody(16 * 1024), async c => {
    query(c, routes.requestWorkReview.query)
    return c.json(await operations.requestWorkReview(authority(c), id(c, 'workId'), await body(c, routes.requestWorkReview.body)))
  })
  // Before `/works/:workId`, which would otherwise read `search` as an id.
  app.get(routes.searchWorks.path, async c => c.json(await operations.searchWorks(authority(c), query(c, routes.searchWorks.query))))
  app.get(routes.getWork.path, async c => {
    query(c, routes.getWork.query)
    const unchanged = c.req.header('If-None-Match')
    if (unchanged && unchanged === JSON.stringify(await operations.getWorkVersion(authority(c), id(c, 'workId')))) {
      c.header('ETag', unchanged); return c.body(null, 304)
    }
    const work = await operations.getWork(authority(c), id(c, 'workId'))
    etag(c, work.version); return c.json(work)
  })
  app.post(routes.createWork.path, limitBody(WORK_BODY_BYTES), async c => {
    query(c, routes.createWork.query)
    const work = await operations.createWork(authority(c), await body(c, routes.createWork.body), idempotencyKey(c))
    c.header('Location', '/v1/works/' + encodeURIComponent(work.id)); etag(c, work.version); return c.json(work, 201)
  })
  app.patch(routes.updateWork.path, limitBody(WORK_BODY_BYTES), async c => {
    query(c, routes.updateWork.query)
    const work = await operations.updateWork(authority(c), id(c, 'workId'), await body(c, routes.updateWork.body), version(c))
    etag(c, work.version); return c.json(work)
  })
  app.get(routes.listWorkActivity.path, async c => c.json(await operations.listWorkActivity(authority(c), id(c, 'workId'), query(c, routes.listWorkActivity.query))))
  app.delete(routes.deleteWork.path, async c => { query(c, routes.deleteWork.query); await operations.deleteWork(authority(c), id(c, 'workId'), version(c)); return c.body(null, 204) })

  app.get(routes.listSessions.path, async c => c.json(await operations.listSessions(authority(c), query(c, routes.listSessions.query))))
  // Before `/sessions/:sessionId`, which would otherwise read `search` as an id.
  app.get(routes.searchSessions.path, async c => c.json(await operations.searchSessions(authority(c), query(c, routes.searchSessions.query))))
  app.post(routes.admitSession.path, limitBody(16 * 1024), async c => {
    query(c, routes.admitSession.query)
    return c.json(await operations.admitSession(authority(c), await body(c, routes.admitSession.body)), 201)
  })
  app.get(routes.getSession.path, async c => { query(c, routes.getSession.query); return c.json(await operations.getSession(authority(c), id(c, 'sessionId'))) })
  app.patch(routes.updateSession.path, limitBody(4 * 1024), async c => {
    query(c, routes.updateSession.query)
    return c.json(await operations.updateSession(authority(c), id(c, 'sessionId'), await body(c, routes.updateSession.body)))
  })
  app.post(routes.admitSessionTurn.path, limitBody(1024), async c => {
    query(c, routes.admitSessionTurn.query)
    await body(c, routes.admitSessionTurn.body)
    await operations.admitSessionTurn(authority(c), id(c, 'sessionId')); return c.body(null, 204)
  })
  app.get(routes.listSessionPullRequests.path, async c => {
    query(c, routes.listSessionPullRequests.query)
    return c.json(await operations.listSessionPullRequests(authority(c), id(c, 'sessionId')))
  })
  app.get(routes.listSessionMessages.path, async c => c.json(await operations.listSessionMessages(authority(c), id(c, 'sessionId'), query(c, routes.listSessionMessages.query))))
  app.get(routes.listSessionActivity.path, async c => c.json(await operations.listSessionActivity(authority(c), id(c, 'sessionId'), query(c, routes.listSessionActivity.query))))
  app.get(routes.listMyActivity.path, async c => c.json(await operations.listMyActivity(authority(c), query(c, routes.listMyActivity.query))))
  // Before `/me/notifications/:notificationId/...`; the fixed segment is never an id.
  app.get(routes.countMyNotifications.path, async c => { query(c, routes.countMyNotifications.query); return c.json(await operations.countMyNotifications(authority(c))) })
  app.get(routes.listMyNotifications.path, async c => c.json(await operations.listMyNotifications(authority(c), query(c, routes.listMyNotifications.query))))
  app.post(routes.setMyNotificationRead.path, limitBody(4 * 1024), async c => {
    query(c, routes.setMyNotificationRead.query)
    return c.json(await operations.setMyNotificationRead(authority(c), id(c, 'notificationId'), await body(c, routes.setMyNotificationRead.body)))
  })
  app.post(routes.setMyNotificationArchived.path, limitBody(4 * 1024), async c => {
    query(c, routes.setMyNotificationArchived.query)
    return c.json(await operations.setMyNotificationArchived(authority(c), id(c, 'notificationId'), await body(c, routes.setMyNotificationArchived.body)))
  })

  app.get(routes.listInsights.path, async c => c.json(await operations.listInsights(authority(c), query(c, routes.listInsights.query))))
  app.get(routes.getInsightSpans.path, async c => { query(c, routes.getInsightSpans.query); return c.json(await operations.getInsightSpans(authority(c), z.string().min(1).max(1024).parse(c.req.param('insightId')))) })
  app.get(routes.getInsight.path, async c => { query(c, routes.getInsight.query); return c.json(await operations.getInsight(authority(c), z.string().min(1).max(1024).parse(c.req.param('insightId')))) })
  return app
}

/**
 * One request from a client's socket (`solusApiRequest`), answered by the routes,
 * schemas, and operations HTTP uses. The socket's principal is its authority, so the
 * client exchanges no credential.
 */
export async function answerSocketRequest(router: SolusApiRouter, input: SolusApiRequest, socketPrincipal: Principal): Promise<SolusApiResponse> {
  const request = solusApiRequestSchema.parse(input)
  // The origin only lets the URL parse; the request never leaves this process.
  const http = new Request(new URL(request.path, 'http://solus.socket'), { method: request.method, headers: solusApiRequestHeaders(request), body: request.body })
  return solusApiResponseOf(await router.fetch(http, { socketPrincipal }))
}

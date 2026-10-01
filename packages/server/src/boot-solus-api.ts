import { sql } from 'drizzle-orm'
import { workspacePresence } from './transport/solus-api/presence'
import { SharedPromptRelay, sharedPromptRequestSchema } from './sharing/shared-prompt'
import { onWorkspaceProjectsChanged } from './projects/workspace-projects'
import { z } from 'zod'
import { DEFAULT_SERVER_PORT } from '@solus/contracts/types'
import { SOLUS_API_AUDIENCE } from '@solus/contracts/uplink'
import { getInstallationId } from './admission/auth'
import { AccessTokenVerifier } from './admission/access-tokens'
import { ANY_ORGANIZATION } from './admission/principal'
import { applyApiMode, apiModeConfig } from './host/api-mode'
import { solusApiSettings } from './host/solus-api-settings'
import { closeDatabase, getDatabase } from './db/database'
import { closeDb } from './db'
import { ShareManager } from './sharing/share-manager'
import { eventVisibleTo } from './sharing/event-audience'
import { taskShareContents, tasksContaining } from './data/tasks/task-sharing'
import { onTasksChanged, taskOrganizationId } from './data/tasks/task-store'
import { workOrganizationId } from './data/works/works'
import { onWorkDeleted, onWorksChanged } from './data/works/work-events'
import { onWorkReviewsChanged } from './data/works/work-reviews'
import { WorkLiveManager } from './work-live/work-live-manager'
import { installWorkLiveBridge } from './data/works/work-live-bridge'
import { getSessionRecord } from './data/sessions/session-records'
import { createWorkspaceOperations } from './data/workspace/service'
import { applyRunnerMirror, applyRunnerOutbox, applyRunnerSessionRecords } from './sync/runner-intake'
import { SolusServer } from './transport/server'
import { buildHttpServer } from './transport/http'
import { attachWebSocketTransport } from './transport/websocket'
import { ClientEventRegistry } from './transport/events/client-event-registry'
import { HostEventPublisher } from './transport/events/host-event-publisher'
import { registerSolusApiHandlers } from './transport/solus-api/service-handlers'

/** Storage/API process. No SessionRuntime, agent backend, automation scheduler, or browser host is constructed. */
export async function bootSolusApi(options: { host?: string; port?: number; staticDir?: string } = {}) {
  applyApiMode()
  const settings = solusApiSettings(true, getInstallationId())
  const tokens = new AccessTokenVerifier({ ...apiModeConfig(), audience: SOLUS_API_AUDIENCE })
  const db = getDatabase()
  await db.get(sql`SELECT 1 AS ready`)
  const shares = new ShareManager({
    db, taskContents: taskShareContents, containingTasks: tasksContaining,
    organizationOfResource: async resource => {
      if (resource.kind === 'task') return taskOrganizationId(resource.id)
      if (resource.kind === 'work') return workOrganizationId(resource.id)
      return (await getSessionRecord(ANY_ORGANIZATION, resource.id))?.organizationId ?? null
    },
  })
  const server = new SolusServer()
  server.useRoles(new Set(['collaboration']))
  server.useResourceAccess(shares)
  let socket: ReturnType<typeof attachWebSocketTransport> | undefined
  const clients = new ClientEventRegistry((clientId, event) => {
    const principal = socket?.principalOf(clientId)
    return principal ? eventVisibleTo(principal, event, shares) : false
  })
  const events = new HostEventPublisher(clients)
  // Organization works are edited live here, where they are stored (work review plan, phase 3b).
  const workLive = new WorkLiveManager({ publish: (clientIds, type, payload) => { void events.publishToRoom({ kind: 'work', id: payload.workId }, clientIds, type, payload) } })
  const uninstallWorkLive = installWorkLiveBridge(workLive.bridge())
  const host = options.host ?? '127.0.0.1'
  let port = options.port ?? DEFAULT_SERVER_PORT
  const presence = workspacePresence(server, events)
  registerSolusApiHandlers(server, { shares, presence, events, workLive, serviceId: settings.serviceId, host, port: () => port })
  const sharedPrompts = new SharedPromptRelay(shares)
  server.register('sharedSessionAvailable', ([sessionId], ctx) => sharedPrompts.available(ctx.principal, sessionId))
  server.register('sharedSessionPrompt', ([request], ctx) => sharedPrompts.prompt(ctx.principal, sharedPromptRequestSchema.parse(request)))
  const { server: http } = buildHttpServer({
    sharedPrompts,
    host, port, getPort: () => port, staticDir: options.staticDir, pairingDisabled: true, isApiMode: true, requireAuth: () => true,
    solusApi: { ...settings, operations: createWorkspaceOperations(shares) },
    verifyAccessToken: (token) => tokens.verify(token),
    resolveShareSecret: secret => shares.resolveLinkSecret(secret),
    runner: {
      applyOutbox: (runner, request) => applyRunnerOutbox(runner, request, shares),
      applySessionRecords: (runner, request) => applyRunnerSessionRecords(runner, request, shares),
      applyMirror: (runner, request) => applyRunnerMirror(runner, request, sessionId => { void events.broadcast('session.transcriptChanged', { sessionId }) }),
    },
  })
  socket = attachWebSocketTransport(http, server, { clientEvents: clients, requireAuth: true,
    onClientConnected: ({ clientId }) => { const principal = socket?.principalOf(clientId); if (principal) presence.connected(clientId, principal) },
    onClientDisconnected: ({ clientId }) => { presence.disconnected(clientId); workLive.disconnected(clientId) },
    onClientExpired: ({ clientId }) => presence.expired(clientId),
  })
  const unsubscribeProjects = onWorkspaceProjectsChanged(() => { void events.broadcast('workspaceProjects.changed', {}) })
  const unsubscribeTasks = onTasksChanged(taskId => {
    // A task's links reach sessions and works: room members are checked again.
    events.forgetRoomAdmissions()
    void events.broadcast('tasks.invalidated', taskId ? { taskId } : {})
  })
  const unsubscribeWorks = onWorksChanged(change => { void events.broadcast('works.changed', change) })
  const unsubscribeWorkDeletes = onWorkDeleted(change => events.prepareBroadcast('works.changed', change))
  const unsubscribeWorkReviews = onWorkReviewsChanged(change => { void events.broadcast('workReviews.changed', change) })
  const unsubscribeLiveDeletes = onWorkDeleted(async change => async () => { workLive.forget(change.workId); return 0 })
  const unsubscribeShares = shares.onChanged(change => {
    // Room members are checked again on their next event; live rooms drop or downgrade who lost access.
    events.forgetRoomAdmissions()
    void workLive.revalidate((principal, resource) => shares.roleFor(principal, resource))
    // Who shared it is the host's to record; the principal behind it never goes on the wire.
    const { organizationSharedBy: _sharedBy, ...payload } = change
    void events.broadcast('share.changed', payload)
    socket?.disconnectWhere(principal => principal.kind === 'guest' && principal.share.resource.kind === change.resource.kind && principal.share.resource.id === change.resource.id, 'Share access changed')
  })
  try {
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject)
      http.listen(port, host, () => { http.off('error', reject); resolve() })
    })
    const address = http.address()
    port = z.object({ port: z.number() }).parse(address).port
  } catch (error) {
    unsubscribeProjects(); unsubscribeTasks(); unsubscribeWorks(); unsubscribeWorkDeletes(); unsubscribeWorkReviews(); unsubscribeLiveDeletes(); uninstallWorkLive(); unsubscribeShares(); socket.close(); http.close()
    await closeDatabase(); closeDb(); throw error
  }
  let stopping: Promise<void> | null = null
  return { host, port, server, shutdown(): Promise<void> {
    return stopping ??= (async () => {
      unsubscribeProjects(); unsubscribeTasks(); unsubscribeWorks(); unsubscribeWorkDeletes(); unsubscribeWorkReviews(); unsubscribeLiveDeletes(); uninstallWorkLive(); unsubscribeShares(); socket?.close()
      await new Promise<void>(resolve => http.close(() => resolve()))
      await closeDatabase(); closeDb()
    })()
  } }
}

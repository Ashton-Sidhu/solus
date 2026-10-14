import { sql } from 'drizzle-orm'
import { createServer, type RequestListener, type Server as HttpServer } from 'node:http'
import { workspacePresence } from './transport/solus-api/presence'
import { onWorkspaceProjectsChanged } from './projects/workspace-projects'
import { z } from 'zod'
import { DEFAULT_SERVER_PORT } from '@solus/contracts/types'
import { SOLUS_API_AUDIENCE, type HostRoute } from '@solus/contracts/uplink'
import { getInstallationId } from './admission/auth'
import { AccessTokenVerifier } from './admission/access-tokens'
import { ANY_ORGANIZATION } from './admission/principal'
import { applyApiMode, apiModeConfig } from './host/api-mode'
import { solusApiSettings } from './host/solus-api-settings'
import { closeDatabase, getDatabase } from './db/database'
import { closeDb } from './db'
import { ShareManager } from './sharing/share-manager'
import { eventVisibleTo } from './sharing/event-audience'
import { onTasksChanged, taskOrganizationId } from './data/tasks/task-store'
import { workOrganizationId } from './data/works/works'
import { onWorkDeleted, onWorksChanged } from './data/works/work-events'
import { onWorkReviewsChanged } from './data/works/work-reviews'
import { publishNotificationChanges } from './notifications/hub-events'
import { WorkLiveManager } from './work-live/work-live-manager'
import { installWorkLiveBridge } from './data/works/work-live-bridge'
import { getSessionRecord } from './data/sessions/session-records'
import { createWorkspaceOperations } from './data/workspace/service'
import { applyRunnerMirror, applyRunnerOutbox, applyRunnerSessionRecords } from './sync/runner-intake'
import { SolusServer } from './transport/server'
import { ActingIdentities, useActingIdentities, withHostScope } from './execution/seats/acting-identity'
import { buildHttpServer, HTTP_SERVER_TIMEOUTS } from './transport/http'
import { attachWebSocketTransport } from './transport/websocket'
import { ClientEventRegistry } from './transport/events/client-event-registry'
import { HostEventPublisher } from './transport/events/host-event-publisher'
import { registerSolusApiHandlers } from './transport/solus-api/service-handlers'
import { onSessionStateChanged } from './data/sessions/session-states'
import { publishSessionViewChanges } from './transport/events/session-view-events'
import { organizationPrSync } from './prs/organization-pr-sync'
import type { PrSync } from './prs/pr-sync'
import { useAccountCredentialSource, type AccountCredentialSource } from './vault/provider-credentials'
import { registerTaskOutboxApplier } from './data/tasks/task-applier'
import { registerSessionOutboxApplier } from './data/sessions/session-applier'
import { registerWorkOutboxApplier } from './data/works/work-applier'

/**
 * The record service without a listener: the request handler, the live transport,
 * and every subscription that feeds it. No SessionRuntime, agent backend, automation
 * scheduler, or browser host is constructed (plans/013-unified-cloud-application.md §4).
 *
 * Ownership: the service owns its subscriptions, the live transport, and the record
 * database, and releases all three in `close`. The caller owns the HTTP server the
 * transport is attached to. Shutdown runs in this order: the caller stops accepting
 * requests, ends live connections (`closeLiveTransport`; an upgraded socket would
 * otherwise hold the server open), waits for requests in flight, then calls `close`.
 */
export interface SolusApiService {
  readonly server: SolusServer
  /** Answers every record path (`isRecordServicePath`); the live transport answers `/ws` before it. */
  readonly requestListener: RequestListener
  /** The routes `requestListener` registers, for the route-ownership guard. */
  readonly routes: readonly { method: string; path: string }[]
  /** Attaches `/ws` (polling and upgrade) to the server that calls `requestListener`. Once only, before it accepts traffic. */
  attachLiveTransport(http: HttpServer): void
  /** Idempotent. Disconnects every live client; the record database stays open for requests in flight. */
  closeLiveTransport(): void
  /** Idempotent. Ends live connections and subscriptions, then closes the record database. */
  close(): Promise<void>
}

export interface SolusApiServiceOptions {
  /** The bind address the connection handlers advertise. */
  host: string
  /** The listener's port, read when a client asks; the caller knows it only after listening. */
  port: () => number
  staticDir?: string
  /** The routes the directory knows for one host, for a share link's guest page (host-sharing.md §4.2); none when the caller keeps no directory. */
  hostRoutes?: (hostId: string) => Promise<HostRoute[]>
  /**
   * A person's account connection, read where the account plane runs in the same
   * process (solus-cloud), parsed with the schema it is given. With it, the service
   * keeps its organization sessions' pull requests fresh as their owners
   * (docs/plans/session-archive.md); without it, it reads none.
   */
  accountCredential?: AccountCredentialSource
}

/** The service's own work runs as the host; each request sets its person's scope (plans/019-acting-identity.md). */
export function createSolusApiService(options: SolusApiServiceOptions): Promise<SolusApiService> {
  return withHostScope(() => createSolusApiServiceAsHost(options))
}

async function createSolusApiServiceAsHost(options: SolusApiServiceOptions): Promise<SolusApiService> {
  applyApiMode()
  // Requests read account connections as their person; the service starts no member process.
  useActingIdentities(new ActingIdentities({
    memberToken: async () => null,
    fetchLogin: async () => { throw new Error('The Solus API reads no GitHub login.') },
    memberHome: () => { throw new Error('The Solus API runs no process for a member.') },
    gitHelper: () => null,
    now: Date.now,
  }))
  const settings = solusApiSettings(true, getInstallationId())
  const tokens = new AccessTokenVerifier({ ...apiModeConfig(), audience: SOLUS_API_AUDIENCE })
  const db = getDatabase()
  try {
    await db.get(sql`SELECT 1 AS ready`)
  } catch (error) {
    await closeDatabase(); closeDb(); throw error
  }
  const shares = new ShareManager({
    db,
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
  const presence = workspacePresence(server, events)
  registerSolusApiHandlers(server, { shares, presence, events, workLive, serviceId: settings.serviceId, host: options.host, port: options.port })
  // A runner's outbox carries an organization's task, work, and session writes
  // here (`/runner/outbox`); without its appliers, the first op stops the queue.
  registerTaskOutboxApplier()
  registerSessionOutboxApplier()
  registerWorkOutboxApplier()
  const { requestListener, routes } = buildHttpServer({
    host: options.host, port: options.port(), getPort: options.port, staticDir: options.staticDir, pairingDisabled: true, isApiMode: true, requireAuth: () => true,
    solusApi: { ...settings, operations: createWorkspaceOperations(shares) },
    verifyAccessToken: (token) => tokens.verify(token),
    resolveShareSecret: secret => shares.resolveLinkSecret(secret),
    // A link's guest page dials the host that runs the session first, and reads this copy when it does not answer (host-sharing.md §4.2).
    resolveShareLink: async secret => {
      const share = await shares.resolveLinkSecret(secret)
      if (!share) return null
      const record = share.resource.kind === 'session' ? await getSessionRecord(share.organizationId, share.resource.id) : null
      const hostId = record?.runnerHostId ?? null
      const routes = hostId && options.hostRoutes ? await options.hostRoutes(hostId) : []
      return { resource: share.resource, role: share.role, organizationId: share.organizationId, host: hostId ? { hostId, routes } : null }
    },
    runner: {
      applyOutbox: (runner, request) => applyRunnerOutbox(runner, request, shares),
      applySessionRecords: (runner, request) => applyRunnerSessionRecords(runner, request, shares),
      applyMirror: (runner, request) => applyRunnerMirror(runner, request, sessionId => { void events.broadcast('session.transcriptChanged', { sessionId }) }, shares),
    },
  })
  const unsubscribeProjects = onWorkspaceProjectsChanged(() => { void events.broadcast('workspaceProjects.changed', {}) })
  // An organization session's place in the list lives here, not on the machine
  // that ran it: machines rotate and go offline (docs/plans/session-archive.md).
  const unsubscribeSessionStates = onSessionStateChanged((sessionId, state) => { void events.broadcast('session.stateChanged', { sessionId, state }) })
  const unsubscribeSessionViews = publishSessionViewChanges(events, () => clients.routableClientIds(), clientId => socket?.principalOf(clientId))
  // The home of organization sessions keeps their pull requests fresh: their machines rotate and go offline.
  let prSync: PrSync | null = null
  if (options.accountCredential) {
    useAccountCredentialSource(options.accountCredential)
    prSync = organizationPrSync((change) => { void events.broadcast('pr.changed', change) })
    prSync.start()
  }
  const unsubscribeTasks = onTasksChanged(taskId => {
    // A task's links reach sessions and works: room members are checked again.
    events.forgetRoomAdmissions()
    void events.broadcast('tasks.invalidated', taskId ? { taskId } : {})
  })
  const unsubscribeWorks = onWorksChanged(change => { void events.broadcast('works.changed', change) })
  const unsubscribeWorkDeletes = onWorkDeleted(change => events.prepareBroadcast('works.changed', change))
  const unsubscribeWorkReviews = onWorkReviewsChanged(change => { void events.broadcast('workReviews.changed', change) })
  const unsubscribeNotifications = publishNotificationChanges(events, () => clients.routableClientIds(), clientId => socket?.principalOf(clientId))
  const unsubscribeLiveDeletes = onWorkDeleted(async change => async () => { workLive.forget(change.workId); return 0 })
  const unsubscribeShares = shares.onChanged(change => {
    // Room members are checked again on their next event; live rooms drop or downgrade who lost access.
    events.forgetRoomAdmissions()
    void workLive.revalidate((principal, resource) => shares.roleFor(principal, resource))
    // Who shared it is the host's to record; the principal behind it never goes on the wire.
    const { organizationSharedBy: _sharedBy, ...payload } = change
    void events.broadcast('share.changed', payload)
    // Only a removed or regenerated link ends its guests, as on the host: a role change applies to them live,
    // and the same rows sent again by a runner change nothing (host-sharing.md §4.2 step 6).
    if (!change.guestsRevoked) return
    socket?.disconnectWhere(principal => principal.kind === 'guest' && principal.share.resource.kind === change.resource.kind && principal.share.resource.id === change.resource.id, 'Share access changed')
  })
  let liveClosed = false
  const closeLiveTransport = () => {
    if (liveClosed) return
    liveClosed = true
    socket?.close()
  }
  let closing: Promise<void> | null = null
  return {
    server, requestListener, routes,
    attachLiveTransport(http) {
      if (socket || liveClosed) throw new Error('The live transport is already attached or closed.')
      socket = attachWebSocketTransport(http, server, { clientEvents: clients, requireAuth: true, verifyAccessToken: (token) => tokens.verify(token),
        onClientConnected: ({ clientId }) => {
          const principal = socket?.principalOf(clientId)
          if (principal) presence.connected(clientId, principal)
        },
        onClientDisconnected: ({ clientId }) => { presence.disconnected(clientId); workLive.disconnected(clientId) },
        onClientExpired: ({ clientId }) => presence.expired(clientId),
      })
    },
    closeLiveTransport,
    close() {
      return closing ??= (async () => {
        prSync?.stop(); useAccountCredentialSource(null)
        unsubscribeProjects(); unsubscribeSessionStates(); unsubscribeSessionViews(); unsubscribeTasks(); unsubscribeWorks(); unsubscribeWorkDeletes(); unsubscribeWorkReviews(); unsubscribeNotifications(); unsubscribeLiveDeletes(); uninstallWorkLive(); unsubscribeShares()
        closeLiveTransport()
        // Disconnected rooms write their bodies in the background; finish before the database closes.
        await workLive.flushAll()
        await closeDatabase(); closeDb()
      })()
    },
  }
}

/** Storage/API process: the record service on a listener of its own. */
export async function bootSolusApi(options: { host?: string; port?: number; staticDir?: string } = {}) {
  const host = options.host ?? '127.0.0.1'
  let port = options.port ?? DEFAULT_SERVER_PORT
  const service = await createSolusApiService({ host, port: () => port, staticDir: options.staticDir })
  const http = createServer(HTTP_SERVER_TIMEOUTS, service.requestListener)
  service.attachLiveTransport(http)
  const stopListening = () => new Promise<void>(resolve => http.close(() => resolve()))
  try {
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject)
      http.listen(port, host, () => { http.off('error', reject); resolve() })
    })
    port = z.object({ port: z.number() }).parse(http.address()).port
  } catch (error) {
    service.closeLiveTransport(); await stopListening(); await service.close(); throw error
  }
  let stopping: Promise<void> | null = null
  return { host, port, server: service.server, shutdown(): Promise<void> {
    return stopping ??= (async () => {
      service.closeLiveTransport()
      await stopListening()
      await service.close()
    })()
  } }
}

/** Applies the record migrations to the database the environment names, then closes it: the release step before a new service admits traffic. */
export async function migrateSolusApiDatabase(): Promise<void> {
  try {
    await getDatabase().get(sql`SELECT 1 AS ready`)
  } finally {
    await closeDatabase(); closeDb()
  }
}

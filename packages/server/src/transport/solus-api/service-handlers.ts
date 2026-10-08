import type { ConnectionsServerInfo } from '@solus/contracts/host-api'
import { z } from 'zod'
import type { SolusServer } from '../server'
import type { ShareManager } from '../../sharing/share-manager'
import type { HostEventPublisher } from '../events/host-event-publisher'
import { registerSharingHandlers } from '../handlers/sharing-handlers'
import { registerTasksHandlers } from '../handlers/tasks-handlers'
import { registerFolioHandlers } from '../handlers/folio-handlers'
import { registerCloudUploadHandlers } from './cloud-uploads'
import { registerWorkReviewHandlers } from '../handlers/work-review-handlers'
import { registerNotificationHubHandlers } from '../handlers/notification-hub-handlers'
import { registerWorkLiveHandlers } from '../handlers/work-live-handlers'
import type { WorkLiveManager } from '../../work-live/work-live-manager'
import { registerCapabilityHandlers } from '../handlers/capability-handlers'
import { recordScopeOf } from '../../admission/principal'
import { getSessionRecord } from '../../data/sessions/session-records'
import { readTranscript, readTranscriptPage } from '../../data/sessions/transcript-reads'
import { deferSessionToolInputs, selectSessionToolInputs } from '../../data/sessions/session-tool-inputs'
import { MAX_SESSION_TOOL_INPUTS } from '@solus/contracts/session-history'
import { appVersion } from '../../platform/paths'
import { registerWorkspaceProjectHandlers } from '../handlers/workspace-project-handlers'
import { registerAssetHandlers } from '../handlers/asset-handlers'
import { sessionMetaFromRecord } from '@solus/contracts/session-record-meta'
import { upsertSessionRecord } from '../../data/sessions/session-records'
import { organizationForNew, type Principal } from '../../admission/principal'
import { activityFor, mergePageActivity, mergeWindowActivity, readActivityPageCursor } from '../../data/activity/activity'
import { getProvider } from '../../providers/registry'

/** The retained collaboration operations; record CRUD exists only on HTTP. */
export function registerSolusApiHandlers(server: SolusServer, deps: {
  presence: { watch(clientId: string, sessionId: string): void; unwatch(clientId: string, sessionId: string): void }
  shares: ShareManager; events: HostEventPublisher; workLive: WorkLiveManager; serviceId: string; host: string; port(): number
}): void {
  registerSharingHandlers(server, { shares: deps.shares })
  registerTasksHandlers(server, { shares: deps.shares, sync: false })
  registerFolioHandlers(server, { shares: deps.shares })
  registerCloudUploadHandlers(server, { shares: deps.shares })
  registerWorkReviewHandlers(server, { shares: deps.shares })
  registerNotificationHubHandlers(server, { shares: deps.shares })
  registerWorkLiveHandlers(server, { live: deps.workLive, shares: deps.shares })
  registerCapabilityHandlers(server, async () => ({ headless: true, desktopHandlers: false, agents: { claude: false, codex: false }, dictation: false,
    platform: process.platform, version: appVersion(), projectCount: 0, agentAuth: { claude: false }, gitAuth: { github: false } }))
  server.register('start', async () => ({ projectPath: '', homePath: '', version: appVersion(), agents: [] }))
  server.register('connectionsGetServerInfo', async (_args, { principal }): Promise<ConnectionsServerInfo> => {
    const info: ConnectionsServerInfo = { host: deps.host, port: deps.port(), allowLan: false,
      installationId: deps.serviceId, remoteAccess: true, requireAuth: true, trustLocalNetwork: false, hostKind: 'cloud', roles: ['collaboration'], principal: principal.kind }
    if (principal.kind === 'org-member') Object.assign(info, { userId: principal.userId, organizationId: principal.organizationId, displayName: principal.displayName })
    if (principal.kind === 'guest') Object.assign(info, { userId: principal.accountUserId, organizationId: principal.organizationId, displayName: principal.displayName, share: { resource: principal.share.resource, role: principal.share.role } })
    return info
  })
  registerWorkspaceProjectHandlers(server)
  // Onboarding's repository list, read with the caller's account GitHub: `handle()` puts
  // their account connections in scope. Whether GitHub is connected is the account's answer.
  server.register('providerRepositories', async ([providerId]) => {
    const provider = getProvider(providerId)
    if (!provider) throw new Error(`No ${providerId} provider is available on this host.`)
    return provider.review.listRepositories()
  })
  registerAssetHandlers(server)
  server.register('sessionRecordUpsert', ([record], ctx) => upsertSessionRecord(organizationForNew(ctx.principal), ctx.principal.kind === 'runner' ? { ...record, runnerHostId: ctx.principal.hostId } : record))
  server.register('getSessionInfo', async ([sessionId], ctx) => {
    const record = await getSessionRecord(recordScopeOf(ctx.principal), sessionId)
    return record ? sessionMetaFromRecord(record) : null
  })
  server.register('getSessionInfos', ([sessionIds], ctx) => Promise.all(sessionIds.map(async sessionId => {
    const record = await getSessionRecord(recordScopeOf(ctx.principal), sessionId)
    return record ? sessionMetaFromRecord(record) : null
  })))
  server.register('describeSession', async ([sessionId], ctx) => {
    const record = await getSessionRecord(recordScopeOf(ctx.principal), sessionId)
    return { lineage: null, meta: record ? sessionMetaFromRecord(record) : null }
  })
  server.register('loadSessionPreview', async ([sessionId], ctx) => {
    const messages = await readTranscript(recordScopeOf(ctx.principal), sessionId)
    return { head: messages.slice(0, 5), tail: messages.slice(5).slice(-5), totalMessages: messages.length }
  })
  // The mirrored history with the activity its runner mirrored beside it, placed as a host places it (plans/012 §5).
  const sessionActivity = (principal: Principal, sessionId: string) => activityFor(recordScopeOf(principal), { kind: 'session', id: sessionId })
  server.register('loadSession', async ([sessionId, _path, _context, _provider, limit, options], ctx) => {
    const history = await readTranscript(recordScopeOf(ctx.principal), sessionId, limit)
    const messages = mergeWindowActivity(history, await sessionActivity(ctx.principal, sessionId), !!limit)
    return options?.deferToolInputs ? deferSessionToolInputs(messages) : messages
  })
  server.register('loadSessionPage', async ([input], ctx) => {
    const request = z.object({ sessionId: z.string().min(1), turnLimit: z.number().int().min(1).max(100), before: z.string().max(16384).optional() }).parse(input)
    const cursor = readActivityPageCursor(request.before)
    const page = await readTranscriptPage(recordScopeOf(ctx.principal), request.sessionId, request.turnLimit, cursor.before)
    const { messages, before } = mergePageActivity(page, await sessionActivity(ctx.principal, request.sessionId), cursor.at)
    return { messages: deferSessionToolInputs(messages), before }
  })
  server.register('loadSessionToolInputs', async ([request], ctx) => {
    if (request.keys.length > MAX_SESSION_TOOL_INPUTS || request.keys.some(key => !/^[a-f0-9]{64}$/.test(key))) throw new Error('Invalid session tool input keys')
    return selectSessionToolInputs(await readTranscript(recordScopeOf(ctx.principal), request.sessionId), request.keys)
  })
  server.register('watchSession', async ([{ sessionId }], ctx) => {
    const record = await getSessionRecord(recordScopeOf(ctx.principal), sessionId)
    if (!record) throw new Error('Session not found')
    deps.presence.watch(ctx.clientId, record.sessionId)
    return {}
  })
  server.register('unwatchSession', async ([sessionId], ctx) => { deps.presence.unwatch(ctx.clientId, sessionId) })
}

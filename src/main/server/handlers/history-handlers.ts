import type { ControlPlane } from '../../control-plane'
import type { AgentId, IpcContext, PlanAnnotations, SessionMeta, SessionScanEvent, SessionTitleChangedEvent } from '../../../shared/types'
import type { SearchSessionsRequest } from '../../../shared/rpc'
import { loadAnnotations, saveAnnotations, toggleBookmarkAnnotations } from '../../plans/annotations'
import { listRecentProjects, trackRecentProject } from '../../recent-projects'
import { createLogger } from '../../logger'
import type { SolusServer } from '../server'
import { getIndexedSession, searchIndexedSessions, setSessionCustomTitle } from '../../db/session-indexer'
import { renamePinnedSession } from '../../sessions/pinned-sessions'
import { generateSessionTitle } from '../../sessions/session-title'
import { takeSessionScanBatch } from '../session-scan'
import type { HostEventPublisher } from '../../events/host-event-publisher'

const log = createLogger('main', 'history-handlers')

export interface HistoryDeps {
  controlPlane: ControlPlane
  events: HostEventPublisher
  agentIdFromContext(ctx?: IpcContext): AgentId
}

export function registerHistoryHandlers(server: SolusServer, deps: HistoryDeps): void {
  const { controlPlane, events, agentIdFromContext } = deps

  server.register('listSessions', async (args, handlerCtx) => {
    const [projectPath, , , streamId, requestedLimit] = args as [string | undefined, unknown, unknown, string | undefined, number | undefined]
    const limitPerProvider = Number.isSafeInteger(requestedLimit) && requestedLimit! > 0 ? requestedLimit : undefined
    log.info('rpc_list_sessions', { projectPath, streamId, limitPerProvider })
    if (!projectPath) return []
    const t0 = Date.now()
    try {
      let batchBuffer: SessionMeta[] = []
      let flushScheduled = false
      const BATCH_SIZE = 20

      function flushBatch() {
        if (batchBuffer.length === 0) return
        const sessions = takeSessionScanBatch(batchBuffer, BATCH_SIZE)
        if (handlerCtx.clientId) {
          events.publish(handlerCtx.clientId, 'session.scanProgressed', { streamId: streamId!, type: 'batch', sessions } satisfies SessionScanEvent)
        }
        flushScheduled = false
      }

      const onBatch = streamId && limitPerProvider === undefined
        ? (sessions: SessionMeta[]) => {
            batchBuffer.push(...sessions)
            if (batchBuffer.length >= BATCH_SIZE) {
              while (batchBuffer.length >= BATCH_SIZE) flushBatch()
            } else if (!flushScheduled) {
              flushScheduled = true
              queueMicrotask(flushBatch)
            }
          }
        : undefined
      const sessions = await controlPlane.listSessionsForProviders(controlPlane.getBackendIds(), projectPath, onBatch, limitPerProvider)
      if (streamId) {
        while (batchBuffer.length > 0) flushBatch()
        if (handlerCtx.clientId) {
          events.publish(handlerCtx.clientId, 'session.scanProgressed', { streamId, type: 'done', totalSessions: sessions.length } satisfies SessionScanEvent)
        }
      }
      log.metric('list_sessions', Date.now() - t0, { count: sessions.length })
      return sessions
    } catch (err) {
      log.error('list_sessions_failed', { error: String(err), projectPath, streamId })
      if (streamId) {
        if (handlerCtx.clientId) {
          events.publish(handlerCtx.clientId, 'session.scanProgressed', { streamId, type: 'done', totalSessions: 0 } satisfies SessionScanEvent)
        }
      }
      return []
    }
  })

  server.register('searchSessions', async (args) => {
    const [request] = args as [SearchSessionsRequest]
    try {
      return searchIndexedSessions(request.query, {
        projectRoot: request.projectRoot,
        providers: request.providers,
        role: request.role,
        sinceTs: request.sinceTs,
      }, request.limit)
    } catch (err) {
      log.error('search_sessions_failed', { error: String(err) })
      return []
    }
  })

  server.register('listRecentProjects', async () => {
    const t0 = Date.now()
    try {
      const projects = await listRecentProjects()
      log.metric('list_recent_projects', Date.now() - t0, { count: projects.length })
      return projects
    } catch (err) {
      log.error('list_recent_projects_failed', { error: String(err) })
      return []
    }
  })

  server.register('trackRecentProject', async (args) => {
    const [path] = args as [string]
    try {
      await trackRecentProject(path)
    } catch (err) {
      log.error('track_recent_project_failed', { error: String(err), path })
    }
  })

  server.register('loadSession', async (args) => {
    const [sessionId, projectPath, ctx, provider, limit] = args as [string, string | undefined, IpcContext | undefined, AgentId | undefined, number | undefined]
    const agentId = provider ?? agentIdFromContext(ctx)
    log.info('rpc_load_session', { sessionId, projectPath, limit })
    try {
      return await controlPlane.loadSession(agentId, sessionId, projectPath, limit)
    } catch (err) {
      log.error('load_session_failed', { error: String(err), sessionId, projectPath })
      return []
    }
  })

  server.register('loadSessionPreview', async (args) => {
    const [sessionId, projectPath, ctx, provider] = args as [string, string | undefined, IpcContext | undefined, AgentId | undefined]
    const agentId = provider ?? agentIdFromContext(ctx)
    log.info('rpc_load_session_preview', { sessionId, projectPath })
    try {
      return await controlPlane.loadSessionPreview(agentId, sessionId, projectPath)
    } catch (err) {
      log.error('load_session_preview_failed', { error: String(err), sessionId, projectPath })
      return { head: [], tail: [], totalMessages: 0 }
    }
  })

  server.register('getSessionInfo', async (args) => {
    const [sessionId] = args as [string]
    try {
      return await controlPlane.getSessionInfo(sessionId)
    } catch (err) {
      log.error('get_session_info_failed', { error: String(err), sessionId })
      return null
    }
  })

  server.register('generateSessionTitle', (args) => {
    const [promptText, cwd] = args as [string, string]
    return generateSessionTitle(controlPlane, promptText, cwd)
  })

  server.register('setSessionTitle', (args) => {
    const [sessionId, title] = args as [string, string | null]
    const trimmed = title?.trim()
    const customTitle = trimmed || null
    setSessionCustomTitle(sessionId, customTitle)
    // A pin carries its own label, so it has to be told: the custom name when
    // there is one, otherwise back to what the session derives its title from.
    const pinLabel = trimmed || getIndexedSession(sessionId)?.firstMessage?.replace(/\s+/g, ' ').slice(0, 80)
    if (pinLabel) renamePinnedSession(sessionId, pinLabel)
    events.broadcast('session.titleChanged', {
      sessionId,
      title: customTitle,
    } satisfies SessionTitleChangedEvent)
    log.info('session_renamed', { sessionId, cleared: !trimmed })
  })

  server.register('listPlans', async (args) => {
    const [projectPath, allProjects] = args as [string | undefined, boolean | undefined]
    log.info('rpc_list_plans', { projectPath, allProjects: !!allProjects })
    const t0 = Date.now()
    try {
      const plans = await controlPlane.listPlansForProviders(controlPlane.getBackendIds(), projectPath, !!allProjects)
      log.metric('list_plans', Date.now() - t0, { count: plans.length, allProjects: !!allProjects })
      return plans
    } catch (err) {
      log.error('list_plans_failed', { error: String(err), projectPath })
      return []
    }
  })

  server.register('loadPlanContent', async (args) => {
    const [sessionId, projectPath, planToolUseId, ctx, provider] = args as [string, string, string, IpcContext | undefined, AgentId | undefined]
    const agentId = provider ?? agentIdFromContext(ctx)
    log.info('rpc_load_plan_content', { sessionId, planToolUseId })
    const t0 = Date.now()
    try {
      const content = await controlPlane.loadPlanContent(agentId, sessionId, projectPath, planToolUseId)
      log.metric('load_plan_content', Date.now() - t0, { sessionId, planToolUseId })
      return content
    } catch (err) {
      log.error('load_plan_content_failed', { error: String(err), sessionId, planToolUseId })
      return null
    }
  })

  server.register('loadPlanAnnotations', async (args) => {
    const [sessionId, planToolUseId] = args as [string, string]
    try {
      return await loadAnnotations(sessionId, planToolUseId)
    } catch (err) {
      log.error('load_plan_annotations_failed', { error: String(err), sessionId, planToolUseId })
      return null
    }
  })

  server.register('savePlanAnnotations', async (args) => {
    const [annotations] = args as [PlanAnnotations]
    try {
      await saveAnnotations(annotations)
      controlPlane.invalidatePlanCaches(annotations.sessionId)
      return { ok: true }
    } catch (err) {
      log.error('save_plan_annotations_failed', { error: String(err), sessionId: annotations.sessionId })
      return { ok: false }
    }
  })

  server.register('toggleBookmarkPlan', async (args) => {
    const [sessionId, projectPath, cwd, planToolUseId, title] = args as [string, string, string, string, string]
    const merged = await toggleBookmarkAnnotations(sessionId, projectPath, cwd, planToolUseId, title)
    controlPlane.invalidatePlanCaches(sessionId)
    return merged
  })
}

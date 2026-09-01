import type { ControlPlane } from '../../control-plane'
import type { AgentId, IpcContext, PlanAnnotations, SessionMeta, SessionScanEvent } from '../../../shared/types'
import { loadAnnotations, saveAnnotations, toggleBookmarkAnnotations } from '../../plans/annotations'
import { listRecentProjects, trackRecentProject } from '../../recent-projects'
import { createLogger } from '../../logger'
import type { SolusServer } from '../server'
import { _planListCache } from '../../agents/claude/claude-plan-helpers'
import { searchIndexedSessions } from '../../db/session-indexer'
import { takeSessionScanBatch } from '../session-scan'

const log = createLogger('main', 'history-handlers')

export interface HistoryDeps {
  controlPlane: ControlPlane
  agentIdFromContext(ctx?: IpcContext): AgentId
}

/** Drop only the cached plan lists that could contain `sessionId`, instead of
 *  wiping every project's cached list on a single bookmark/comment edit. */
function invalidatePlanListCacheForSession(sessionId: string): void {
  _planListCache.invalidateWhere((_key, descriptors) => descriptors.some((d) => d.sessionId === sessionId))
}

export function registerHistoryHandlers(server: SolusServer, deps: HistoryDeps): void {
  const { controlPlane, agentIdFromContext } = deps

  server.register('listSessions', async (args, handlerCtx) => {
    const [projectPath, , , streamId, requestedLimit] = args as [string | undefined, unknown, unknown, string | undefined, number | undefined]
    const limitPerProvider = Number.isSafeInteger(requestedLimit) && requestedLimit! > 0 ? requestedLimit : undefined
    log.info(`RPC listSessions ${projectPath ? `(path=${projectPath})` : ''}${streamId ? ` stream=${streamId}` : ''}`)
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
          server.sendTo(handlerCtx.clientId, 'session-scan', { streamId: streamId!, type: 'batch', sessions } satisfies SessionScanEvent)
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
          server.sendTo(handlerCtx.clientId, 'session-scan', { streamId, type: 'done', totalSessions: sessions.length } satisfies SessionScanEvent)
        }
      }
      log.metric('listSessions', Date.now() - t0, { count: sessions.length })
      return sessions
    } catch (err) {
      log.error(`listSessions error: ${err}`)
      if (streamId) {
        if (handlerCtx.clientId) {
          server.sendTo(handlerCtx.clientId, 'session-scan', { streamId, type: 'done', totalSessions: 0 } satisfies SessionScanEvent)
        }
      }
      return []
    }
  })

  server.register('searchSessions', async (args) => {
    const [request] = args as [{ query: string; projectPath?: string; limit?: number }]
    try {
      return searchIndexedSessions(request.query, request.projectPath, request.limit)
    } catch (err) {
      log.error(`searchSessions error: ${err}`)
      return []
    }
  })

  server.register('listRecentProjects', async () => {
    const t0 = Date.now()
    try {
      const projects = await listRecentProjects()
      log.metric('listRecentProjects', Date.now() - t0, { count: projects.length })
      return projects
    } catch (err) {
      log.error(`listRecentProjects error: ${err}`)
      return []
    }
  })

  server.register('trackRecentProject', async (args) => {
    const [path] = args as [string]
    try {
      await trackRecentProject(path)
    } catch (err) {
      log.error(`trackRecentProject error: ${err}`)
    }
  })

  server.register('loadSession', async (args) => {
    const [sessionId, projectPath, ctx, provider, limit] = args as [string, string | undefined, IpcContext | undefined, AgentId | undefined, number | undefined]
    const agentId = provider ?? agentIdFromContext(ctx)
    log.info(`RPC loadSession ${sessionId}${projectPath ? ` (path=${projectPath})` : ''}${limit ? ` (limit=${limit})` : ''}`)
    try {
      return await controlPlane.loadSession(agentId, sessionId, projectPath, limit)
    } catch (err) {
      log.error(`loadSession error: ${err}`)
      return []
    }
  })

  server.register('loadSessionPreview', async (args) => {
    const [sessionId, projectPath, ctx, provider] = args as [string, string | undefined, IpcContext | undefined, AgentId | undefined]
    const agentId = provider ?? agentIdFromContext(ctx)
    log.info(`RPC loadSessionPreview ${sessionId}${projectPath ? ` (path=${projectPath})` : ''}`)
    try {
      return await controlPlane.loadSessionPreview(agentId, sessionId, projectPath)
    } catch (err) {
      log.error(`loadSessionPreview error: ${err}`)
      return { head: [], tail: [], totalMessages: 0 }
    }
  })

  server.register('getSessionInfo', async (args) => {
    const [sessionId, projectPath, ctx, provider] = args as [string, string | undefined, IpcContext | undefined, AgentId | undefined]
    const agentId = provider ?? agentIdFromContext(ctx)
    try {
      return await controlPlane.getSessionInfo(agentId, sessionId, projectPath)
    } catch (err) {
      log.error(`getSessionInfo error: ${err}`)
      return null
    }
  })

  server.register('listPlans', async (args) => {
    const [projectPath, allProjects] = args as [string | undefined, boolean | undefined]
    log.info(`RPC listPlans ${allProjects ? '(all projects)' : projectPath ? `(path=${projectPath})` : ''}`)
    const t0 = Date.now()
    try {
      const plans = await controlPlane.listPlansForProviders(controlPlane.getBackendIds(), projectPath, !!allProjects)
      log.metric('listPlans', Date.now() - t0, { count: plans.length, allProjects: !!allProjects })
      return plans
    } catch (err) {
      log.error(`listPlans error: ${err}`)
      return []
    }
  })

  server.register('loadPlanContent', async (args) => {
    const [sessionId, projectPath, planToolUseId, ctx, provider] = args as [string, string, string, IpcContext | undefined, AgentId | undefined]
    const agentId = provider ?? agentIdFromContext(ctx)
    log.info(`RPC loadPlanContent session=${sessionId} toolUse=${planToolUseId}`)
    const t0 = Date.now()
    try {
      const content = await controlPlane.loadPlanContent(agentId, sessionId, projectPath, planToolUseId)
      log.metric('loadPlanContent', Date.now() - t0, { sessionId, planToolUseId })
      return content
    } catch (err) {
      log.error(`loadPlanContent error: ${err}`)
      return null
    }
  })

  server.register('loadPlanAnnotations', async (args) => {
    const [sessionId, planToolUseId] = args as [string, string]
    try {
      return await loadAnnotations(sessionId, planToolUseId)
    } catch (err) {
      log.error(`loadPlanAnnotations error: ${err}`)
      return null
    }
  })

  server.register('savePlanAnnotations', async (args) => {
    const [annotations] = args as [PlanAnnotations]
    try {
      await saveAnnotations(annotations)
      invalidatePlanListCacheForSession(annotations.sessionId)
      return { ok: true }
    } catch (err) {
      log.error(`savePlanAnnotations error: ${err}`)
      return { ok: false }
    }
  })

  server.register('toggleBookmarkPlan', async (args) => {
    const [sessionId, projectPath, cwd, planToolUseId, title] = args as [string, string, string, string, string]
    const merged = await toggleBookmarkAnnotations(sessionId, projectPath, cwd, planToolUseId, title)
    invalidatePlanListCacheForSession(sessionId)
    return merged
  })
}

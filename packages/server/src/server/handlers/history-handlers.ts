import type { ControlPlane } from '../../control-plane'
import type { AgentId, IpcContext, SessionMeta, SessionScanEvent, SessionTitleChangedEvent } from '@solus/contracts/types'
import { loadAnnotations, saveAnnotations, toggleBookmarkAnnotations } from '../../plans/annotations'
import { listRecentProjects, trackRecentProject } from '../../recent-projects'
import { createLogger, isDebugEnabled } from '../../logger'
import { recordOtelDuration } from '../../otel'
import type { SolusServer } from '../server'
import { getIndexedSession, getSessionMessageWindow, searchIndexedSessions, setSessionBranch, setSessionCustomTitle } from '../../db/session-indexer'
import { renamePinnedSession } from '../../sessions/pinned-sessions'
import { generateSessionMetadata } from '../../sessions/session-title'
import { updateGeneratedMetadataForSession } from '../../tasks/task-sessions'
import { emitChanged } from '../../tasks/task-store'
import { takeSessionScanBatch } from '../session-scan'
import type { HostEventPublisher } from '../../events/host-event-publisher'
import { projectSessionHistory, serializedBytes } from '../result-projection'

const log = createLogger('main', 'history-handlers')

export interface HistoryDeps {
  controlPlane: ControlPlane
  events: HostEventPublisher
  agentIdFromContext(ctx?: IpcContext): AgentId
}

export function registerHistoryHandlers(server: SolusServer, deps: HistoryDeps): void {
  const { controlPlane, events, agentIdFromContext } = deps

  server.register('listSessions', async (args, handlerCtx) => {
    const [projectPath, , , streamId, requestedLimit] = args
    const limitPerProvider = requestedLimit !== undefined && Number.isSafeInteger(requestedLimit) && requestedLimit > 0
      ? requestedLimit
      : undefined
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
          if (streamId) {
            events.publish(handlerCtx.clientId, 'session.scanProgressed', { streamId, type: 'batch', sessions } satisfies SessionScanEvent)
          }
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
      recordOtelDuration('list_sessions', Date.now() - t0, { count: sessions.length })
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
    const [request] = args
    try {
      return searchIndexedSessions(request.query, {
        projectRoot: request.projectRoot,
        providers: request.providers,
        role: request.role,
        sinceTs: request.sinceTs,
        prefixLastToken: request.prefixLastToken,
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
      recordOtelDuration('list_recent_projects', Date.now() - t0, { count: projects.length })
      return projects
    } catch (err) {
      log.error('list_recent_projects_failed', { error: String(err) })
      return []
    }
  })

  server.register('trackRecentProject', async (args) => {
    const [path] = args
    try {
      await trackRecentProject(path)
    } catch (err) {
      log.error('track_recent_project_failed', { error: String(err), path })
    }
  })

  server.register('loadSession', async (args) => {
    const [sessionId, projectPath, ctx, provider, limit] = args
    const agentId = provider ?? agentIdFromContext(ctx)
    log.info('rpc_load_session', { sessionId, projectPath, limit })
    try {
      const messages = await controlPlane.loadSession(agentId, sessionId, projectPath, limit)
      if (isDebugEnabled()) {
        // Serialize each message once and sum for the total, instead of
        // stringifying the whole multi-MB transcript a second time.
        let totalBytes = 0
        for (const message of messages) {
          const bytes = serializedBytes(message)
          totalBytes += bytes
          const details = {
            sessionId,
            eventType: message.role,
            bytes,
          }
          if (message.toolName) Object.assign(details, { toolName: message.toolName })
          log.debug('session_event_bytes', details)
        }
        log.debug('session_load_bytes', { sessionId, bytes: totalBytes, messageCount: messages.length })
      }
      return projectSessionHistory(messages)
    } catch (err) {
      log.error('load_session_failed', { error: String(err), sessionId, projectPath })
      return []
    }
  })

  server.register('loadSessionPreview', async (args) => {
    const [sessionId, projectPath, ctx, provider] = args
    const agentId = provider ?? agentIdFromContext(ctx)
    log.info('rpc_load_session_preview', { sessionId, projectPath })
    try {
      return await controlPlane.loadSessionPreview(agentId, sessionId, projectPath)
    } catch (err) {
      log.error('load_session_preview_failed', { error: String(err), sessionId, projectPath })
      return { head: [], tail: [], totalMessages: 0 }
    }
  })

  server.register('loadSessionMessageWindow', async (args) => {
    const [request] = args
    try {
      return getSessionMessageWindow(request.sessionId, request.messageId, request.radius)
    } catch (err) {
      log.error('load_session_message_window_failed', { error: String(err), sessionId: request.sessionId })
      return { messages: [], hiddenBefore: 0, hiddenAfter: 0 }
    }
  })

  server.register('getSessionInfo', async (args) => {
    const [sessionId] = args
    try {
      return await controlPlane.getSessionInfo(sessionId)
    } catch (err) {
      log.error('get_session_info_failed', { error: String(err), sessionId })
      return null
    }
  })

  server.register('getSessionInfos', async (args) => {
    const [sessionIds] = args
    return Promise.all(sessionIds.map(async (sessionId) => {
      try {
        return await controlPlane.getSessionInfo(sessionId)
      } catch (err) {
        log.error('get_session_info_failed', { error: String(err), sessionId })
        return null
      }
    }))
  })

  server.register('resolveSessionLineage', (args) => {
    const [provider, providerSessionId] = args
    try {
      return controlPlane.resolveSessionLineage(provider, providerSessionId)
    } catch (err) {
      log.error('resolve_session_handoff_failed', { error: String(err), provider, providerSessionId })
      return null
    }
  })

  server.register('generateSessionMetadata', (args) => {
    const [promptText, cwd, context] = args
    return generateSessionMetadata(controlPlane, promptText, cwd, context)
  })

  server.register('setSessionTitle', async (args) => {
    const [sessionId, title, source = 'manual', generatedDescription, publishEvent = true] = args
    const trimmed = title?.trim()
    const customTitle = trimmed || null
    setSessionCustomTitle(sessionId, customTitle)
    let taskCatalogChanged = false
    try {
      if (source === 'generated') {
        if (trimmed && generatedDescription) {
          taskCatalogChanged = !!await updateGeneratedMetadataForSession(
            sessionId,
            trimmed,
            generatedDescription,
          )
        }
      } else {
        // Session names and task names have separate owners. The task snapshot
        // still needs a refresh because its attempt rows join this session
        // title, but renaming one attempt must not rename the shared task.
        emitChanged()
        taskCatalogChanged = true
      }
    } catch (error) {
      log.warn('task_session_metadata_update_failed', { sessionId, error: String(error) })
    }
    // A pin carries its own label, so it has to be told: the custom name when
    // there is one, otherwise back to what the session derives its title from.
    const pinLabel = trimmed || getIndexedSession(sessionId)?.firstMessage?.replace(/\s+/g, ' ').slice(0, 80)
    if (pinLabel) renamePinnedSession(sessionId, pinLabel)
    if (publishEvent) {
      const event: SessionTitleChangedEvent = {
        sessionId,
        title: customTitle,
        source,
      }
      if (generatedDescription) event.generatedDescription = generatedDescription
      events.broadcast('session.titleChanged', event)
    } else if (!taskCatalogChanged) {
      // The proxy row changed even when a generated task name lost a race to a
      // manual edit. Other clients of the task host still need to reload it.
      emitChanged()
    }
    log.info('session_renamed', { sessionId, cleared: !trimmed, taskCatalogChanged })
  })

  server.register('setSessionBranch', (args) => {
    const [sessionId, branch] = args
    setSessionBranch(sessionId, branch)
    emitChanged()
  })

  server.register('listPlans', async (args) => {
    const [projectPath, allProjects] = args
    log.info('rpc_list_plans', { projectPath, allProjects: !!allProjects })
    const t0 = Date.now()
    try {
      const plans = await controlPlane.listPlansForProviders(controlPlane.getBackendIds(), projectPath, !!allProjects)
      recordOtelDuration('list_plans', Date.now() - t0, { count: plans.length, allProjects: !!allProjects })
      return plans
    } catch (err) {
      log.error('list_plans_failed', { error: String(err), projectPath })
      return []
    }
  })

  server.register('loadPlanContent', async (args) => {
    const [sessionId, projectPath, planToolUseId, ctx, provider] = args
    const agentId = provider ?? agentIdFromContext(ctx)
    log.info('rpc_load_plan_content', { sessionId, planToolUseId })
    const t0 = Date.now()
    try {
      const content = await controlPlane.loadPlanContent(agentId, sessionId, projectPath, planToolUseId)
      recordOtelDuration('load_plan_content', Date.now() - t0, { sessionId, planToolUseId })
      return content
    } catch (err) {
      log.error('load_plan_content_failed', { error: String(err), sessionId, planToolUseId })
      return null
    }
  })

  server.register('loadPlanAnnotations', async (args) => {
    const [sessionId, planToolUseId] = args
    try {
      return await loadAnnotations(sessionId, planToolUseId)
    } catch (err) {
      log.error('load_plan_annotations_failed', { error: String(err), sessionId, planToolUseId })
      return null
    }
  })

  server.register('savePlanAnnotations', async (args) => {
    const [annotations] = args
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
    const [sessionId, projectPath, cwd, planToolUseId, title] = args
    const merged = await toggleBookmarkAnnotations(sessionId, projectPath, cwd, planToolUseId, title)
    controlPlane.invalidatePlanCaches(sessionId)
    return merged
  })
}

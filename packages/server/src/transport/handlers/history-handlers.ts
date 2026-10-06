import { z } from 'zod'
import type { SessionRuntime } from '../../execution/session-runtime'
import type { AgentId, ExchangeProgress, IpcContext, SessionMeta, SessionTitleChangedEvent } from '@solus/contracts/types'
import { loadAnnotations, saveAnnotations, toggleBookmarkAnnotations } from '../../plans/annotations'
import { listRecentProjects, trackRecentProject } from '../../recent-projects'
import { createLogger, isDebugEnabled } from '../../logger'
import { recordOtelDuration } from '../../otel'
import type { HandlerCtx, SolusServer } from '../server'
import { organizationForNew, recordScopeOf } from '../../admission/principal'
import { attributionOf } from '../../admission/actor'
import { stampComments } from '../../annotations/stored-comments'
import { getIndexedSession, getSessionMessageWindow, setSessionBranch, setSessionCustomTitle } from '../../db/session-indexer'
import { sessionMetaFromRecord } from '@solus/contracts/session-record-meta'
import { getSessionRecord, upsertSessionRecord } from '../../data/sessions/session-records'
import { readTranscript, readTranscriptPage } from '../../data/sessions/transcript-reads'
import { isApiMode } from '../../host/api-mode'
import { renamePinnedSession } from '../../data/sessions/pinned-sessions'
import { projectsVisibleTo } from './setup-handlers'
import { generateSessionMetadata } from '../../execution/sessions/session-title'
import { ensureBackgroundSessionTitle } from '../../execution/sessions/background-session-title'
import { sessionExecutionPreferences } from '../../data/sessions/session-states'
import { emitSessionTasksChanged } from '../../data/tasks/task-sessions'
import type { HostEventPublisher } from '../events/host-event-publisher'
import { projectSessionHistory, serializedBytes, withExchangeProgress } from '../../data/sessions/result-projection'
import { storePromptImages } from '../../data/assets/transcript-images'
import { deferSessionToolInputs, selectSessionToolInputs } from '../../data/sessions/session-tool-inputs'
import { MAX_SESSION_TOOL_INPUTS, type SessionHistoryPage, type WireSessionLoadMessage } from '@solus/contracts/session-history'
import { activityFor, mergePageActivity, mergeWindowActivity, readActivityPageCursor } from '../../data/activity/activity'

const log = createLogger('main', 'history-handlers')

export interface HistoryDeps {
  sessionRuntime: SessionRuntime
  events: HostEventPublisher
  agentIdFromContext(ctx?: IpcContext): AgentId
  /** Where an exchange a transcript names stands now, from the orchestrator. */
  exchangeProgress(exchangeId: string): ExchangeProgress | undefined
}

export function registerHistoryHandlers(server: SolusServer, deps: HistoryDeps): void {
  const { sessionRuntime, events, agentIdFromContext, exchangeProgress } = deps
  // On the workspace service the history is the mirrored copy
  // (cloud-service-model.md §6): no provider files live there.
  /**
   * A session's history as a client may see it: on the workspace service the
   * rows a runner mirrored, already projected; on a host the provider's
   * transcript, projected here.
   */
  const historyOf = async (handlerCtx: HandlerCtx, agentId: AgentId, sessionId: string, projectPath?: string, limit?: number): Promise<WireSessionLoadMessage[]> =>
    isApiMode()
      ? readTranscript(recordScopeOf(handlerCtx.principal), sessionId, limit)
      : projectSessionHistory(storePromptImages(await sessionRuntime.history.loadSession(agentId, sessionId, projectPath, limit)))
  /** A session's activity for a history read (plans/012 §5). */
  const sessionActivityOf = (handlerCtx: HandlerCtx, sessionId: string) =>
    activityFor(recordScopeOf(handlerCtx.principal), { kind: 'session', id: sessionId })
  const sessionInfoOf = async (handlerCtx: HandlerCtx, sessionId: string): Promise<SessionMeta | null> => {
    const meta = await sessionRuntime.history.getSessionInfo(sessionId)
    if (meta || !isApiMode()) return meta
    const record = await getSessionRecord(recordScopeOf(handlerCtx.principal), sessionId)
    return record ? sessionMetaFromRecord(record) : null
  }

  // The collaboration plane's session records (docs/plans/cloud-service-model.md).

  server.register('sessionRecordUpsert', async (args, ctx) => {
    const [record] = args
    // A runner's report names the runner; it cannot speak for another host.
    const report = ctx.principal.kind === 'runner' ? { ...record, runnerHostId: ctx.principal.hostId } : record
    return upsertSessionRecord(organizationForNew(ctx.principal), report)
  })

  server.register('listRecentProjects', async (_args, ctx) => {
    const t0 = Date.now()
    try {
      const projects = projectsVisibleTo(ctx.principal, await listRecentProjects())
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

  server.register('loadSession', async (args, handlerCtx) => {
    const [sessionId, projectPath, ctx, provider, limit, options] = args
    const agentId = provider ?? agentIdFromContext(ctx)
    log.info('rpc_load_session', { sessionId, projectPath, limit })
    try {
      const history = await historyOf(handlerCtx, agentId, sessionId, projectPath, limit)
      const messages = mergeWindowActivity(history, await sessionActivityOf(handlerCtx, sessionId), !!limit)
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
      const current = withExchangeProgress(messages, exchangeProgress)
      return options?.deferToolInputs ? deferSessionToolInputs(current) : current
    } catch (err) {
      log.error('load_session_failed', { error: String(err), sessionId, projectPath })
      return []
    }
  })

  server.register('loadSessionPage', async ([input], handlerCtx) => {
    const startedAt = Date.now()
    const request = z.object({
      sessionId: z.string().min(1),
      provider: z.enum(['claude-code', 'codex', 'opencode']),
      projectPath: z.string().optional(),
      turnLimit: z.number().int().min(1).max(100),
      before: z.string().max(16384).optional(),
    }).parse(input)
    const cursor = readActivityPageCursor(request.before)
    const pageRequest = { ...request, before: cursor.before }
    const page: SessionHistoryPage = isApiMode()
      ? await readTranscriptPage(recordScopeOf(handlerCtx.principal), pageRequest.sessionId, pageRequest.turnLimit, pageRequest.before)
      : await sessionRuntime.history.loadSessionPage(pageRequest).then((loaded) => ({ messages: projectSessionHistory(storePromptImages(loaded.messages)), before: loaded.before }))
    const { messages, before } = mergePageActivity(page, await sessionActivityOf(handlerCtx, request.sessionId), cursor.at)
    recordOtelDuration('load_session_page', Date.now() - startedAt, { provider: request.provider, count: messages.length })
    log.info('session_history_page_loaded', {
      sessionId: request.sessionId, provider: request.provider, messageCount: messages.length,
      olderPage: !!request.before, hasMore: page.before !== null, durationMs: Date.now() - startedAt,
    })
    return {
      messages: deferSessionToolInputs(withExchangeProgress(messages, exchangeProgress)),
      before,
    }
  })

  server.register('loadSessionToolInputs', async ([request], handlerCtx) => {
    if (!request.keys.length) return []
    if (request.keys.length > MAX_SESSION_TOOL_INPUTS || request.keys.some((key) => !/^[a-f0-9]{64}$/.test(key))) {
      throw new Error('Invalid session tool input keys')
    }
    const messages = await historyOf(handlerCtx, request.provider, request.sessionId, request.projectPath)
    return selectSessionToolInputs(messages, request.keys)
  })

  server.register('loadSessionPreview', async (args) => {
    const [sessionId, projectPath, ctx, provider] = args
    const agentId = provider ?? agentIdFromContext(ctx)
    log.info('rpc_load_session_preview', { sessionId, projectPath })
    try {
      return await sessionRuntime.history.loadSessionPreview(agentId, sessionId, projectPath)
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

  server.register('getSessionInfo', async (args, handlerCtx) => {
    const [sessionId] = args
    try {
      return await sessionInfoOf(handlerCtx, sessionId)
    } catch (err) {
      log.error('get_session_info_failed', { error: String(err), sessionId })
      return null
    }
  })

  server.register('getSessionInfos', async (args, handlerCtx) => {
    const [sessionIds] = args
    return Promise.all(sessionIds.map(async (sessionId) => {
      try {
        return await sessionInfoOf(handlerCtx, sessionId)
      } catch (err) {
        log.error('get_session_info_failed', { error: String(err), sessionId })
        return null
      }
    }))
  })

  server.register('describeSession', async (args, handlerCtx) => {
    const [sessionId] = args
    try {
      const description = await sessionRuntime.history.describeSession(sessionId)
      if (description.meta || !isApiMode()) return description
      return { ...description, meta: await sessionInfoOf(handlerCtx, sessionId) }
    } catch (err) {
      log.error('describe_session_failed', { error: String(err), sessionId })
      return { lineage: null, meta: null }
    }
  })

  server.register('generateSessionMetadata', (args, ctx) => {
    const [promptText, cwd, context] = args
    // The run uses the caller's own provider login, as their turns do.
    return generateSessionMetadata(sessionRuntime, promptText, cwd, context, (provider) => sessionRuntime.seatForTurn(ctx.actor, provider))
  })

  server.register('ensureBackgroundSessionTitle', async (args, ctx) => {
    const [sessionId, preferences] = args
    return ensureBackgroundSessionTitle(sessionRuntime, events, {
      sessionId,
      preferences: await sessionExecutionPreferences(sessionId) ?? preferences,
      actor: ctx.actor,
    })
  })

  server.register('setSessionTitle', async (args, ctx) => {
    const [sessionId, title, source = 'manual', generatedDescription, publishEvent = true] = args
    const trimmed = title?.trim()
    const customTitle = trimmed || null
    const previousTitle = getIndexedSession(sessionId)?.customTitle ?? null
    await setSessionCustomTitle(sessionId, customTitle)
    let taskCatalogChanged = false
    try {
      // Session names and task names have separate owners. The task snapshot
      // still needs a refresh because its attempt rows join this session
      // title, but naming one attempt must not rename the shared task.
      await emitSessionTasksChanged(recordScopeOf(ctx.principal), sessionId)
      taskCatalogChanged = true
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
      // A person's rename is activity, so a teammate reads who did it, now and after a reload (plan 004 step 12).
      // Every client re-sends a name typed before the session had an id; the same name again is no rename.
      if (source === 'manual' && ctx.actor.user && customTitle !== previousTitle) {
        void sessionRuntime.recordActivity({ kind: 'session', id: sessionId }, ctx.actor, { kind: 'renamed', title: customTitle ?? '' })
      }
    } else if (!taskCatalogChanged) {
      // The proxy row changed even when a generated task name lost a race to a
      // manual edit. Other clients of the task host still need to reload it.
      await emitSessionTasksChanged(recordScopeOf(ctx.principal), sessionId)
    }
    log.info('session_renamed', { sessionId, cleared: !trimmed, taskCatalogChanged })
  })

  server.register('setSessionBranch', async (args, ctx) => {
    const [sessionId, branch] = args
    setSessionBranch(sessionId, branch)
    await emitSessionTasksChanged(recordScopeOf(ctx.principal), sessionId)
  })

  server.register('listPlans', async (args) => {
    const [projectPath, allProjects] = args
    log.info('rpc_list_plans', { projectPath, allProjects: !!allProjects })
    const t0 = Date.now()
    try {
      const plans = await sessionRuntime.history.listPlansForProviders(sessionRuntime.getBackendIds(), projectPath, !!allProjects)
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
      const content = await sessionRuntime.history.loadPlanContent(agentId, sessionId, projectPath, planToolUseId)
      recordOtelDuration('load_plan_content', Date.now() - t0, { sessionId, planToolUseId })
      return content
    } catch (err) {
      log.error('load_plan_content_failed', { error: String(err), sessionId, planToolUseId })
      return null
    }
  })

  server.register('loadPlanAnnotations', async (args, ctx) => {
    const [sessionId, planToolUseId] = args
    try {
      return await loadAnnotations(recordScopeOf(ctx.principal), sessionId, planToolUseId)
    } catch (err) {
      log.error('load_plan_annotations_failed', { error: String(err), sessionId, planToolUseId })
      return null
    }
  })

  server.register('savePlanAnnotations', async (args, ctx) => {
    const [annotations] = args
    try {
      // The client sends the whole plan; whatever it wrote and the host has not stamped yet is the caller's.
      await saveAnnotations(recordScopeOf(ctx.principal), { ...annotations, comments: stampComments(annotations.comments, attributionOf(ctx.actor)) })
      sessionRuntime.history.invalidatePlanCaches(annotations.sessionId)
      return { ok: true }
    } catch (err) {
      log.error('save_plan_annotations_failed', { error: String(err), sessionId: annotations.sessionId })
      return { ok: false }
    }
  })

  server.register('toggleBookmarkPlan', async (args, ctx) => {
    const [sessionId, projectPath, cwd, planToolUseId, title] = args
    const merged = await toggleBookmarkAnnotations(recordScopeOf(ctx.principal), sessionId, projectPath, cwd, planToolUseId, title)
    sessionRuntime.history.invalidatePlanCaches(sessionId)
    return merged
  })
}

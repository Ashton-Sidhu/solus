import { z } from 'zod'
import { HistoryPageManifests, resumeHistoryPage } from '../../data/sessions/history-blocks'
import type { SessionRuntime } from '../../execution/session-runtime'
import { isResponseForkCursor, needsResponseFork, readResponseForkPage, savedResponseFork } from '../../execution/sessions/response-fork'
import { readSessionExecution } from '../../data/sessions/session-executions'
import { readSessionTree } from '../../data/sessions/session-digests'
import { sessionTreeRelations } from '../../data/sessions/session-tree-relations'
import { hostStarterOf } from '@solus/contracts/session-starter'
import type { AgentId, ExchangeProgress, IpcContext, SessionMeta } from '@solus/contracts/types'
import { loadAnnotations, saveAnnotations, toggleBookmarkAnnotations } from '../../plans/annotations'
import { listRecentProjects, trackRecentProject } from '../../recent-projects'
import { formContainerCodebases } from '../../execution/sessions/session-codebase-formation'
import { createLogger, isDebugEnabled } from '../../logger'
import { recordOtelDuration } from '../../otel'
import type { HandlerCtx, SolusServer } from '../server'
import { organizationForNew, recordScopeOf } from '../../admission/principal'
import { attributionOf } from '../../admission/actor'
import { stampComments } from '../../annotations/stored-comments'
import { notifyAnnotationsChanged } from '../../annotations/annotation-events'
import { getSessionMessageWindow, setSessionBranch } from '../../db/session-indexer'
import { sessionMetaFromRecord } from '@solus/contracts/session-record-meta'
import { getSessionRecord, organizationOfSession, upsertSessionRecord } from '../../data/sessions/session-records'
import { LOCAL_ORGANIZATION_ID } from '../../host/machine-kind'
import { readSessionStorage } from '../../data/sessions/session-storage'
import { readTranscript, readTranscriptPage, readTranscriptMessageWindow } from '../../data/sessions/transcript-reads'
import { isApiMode } from '../../host/api-mode'
import { projectsVisibleTo } from './setup-handlers'
import { generateSessionMetadata } from '../../execution/sessions/session-title'
import { ensureBackgroundSessionTitle } from '../../execution/sessions/background-session-title'
import { renameSession } from '../../execution/sessions/session-rename'
import { sessionExecutionPreferences } from '../../data/sessions/session-states'
import { actingPreferences } from '../../execution/person-settings'
import { emitSessionTasksChanged } from '../../data/tasks/task-sessions'
import type { HostEventPublisher } from '../events/host-event-publisher'
import { recordArtifactFrameHeight, withArtifactLayouts, withReplyHtmlLayouts } from '../../data/works/artifact-layout'
import { readHistoryThroughEntry } from '../../data/sessions/history-through-entry'
import { withTurnItemBodies, projectPromptFiles, projectSessionHistory, serializedBytes, withExchangeProgress } from '../../data/sessions/result-projection'
import { storePromptImages } from '../../data/assets/transcript-images'
import { deferSavedArtifactHtml, deferSessionToolInputs, selectSessionToolInputs } from '../../data/sessions/session-tool-inputs'
import { MAX_SESSION_TOOL_INPUTS, type ProviderHistoryPage, type SessionHistoryPage, type SessionLoadMessage, type WireSessionLoadMessage } from '@solus/contracts/session-history'
import { activityFor, historyWindow, mergePageActivity, mergeWindowActivity, pageWindow, readActivityPageCursor, type ActivityWindow } from '../../data/activity/activity'
import { agentIdSchema } from '@solus/contracts/types'

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
  async function forkHistory(
    handlerCtx: HandlerCtx, sessionId: string, turnLimit: number, before?: string,
  ): Promise<ProviderHistoryPage | null> {
    if (isApiMode() || (!needsResponseFork(sessionId) && !isResponseForkCursor(before))) return null
    const record = await getSessionRecord(recordScopeOf(handlerCtx.principal), sessionId)
    const fork = savedResponseFork(record)
    if (!record || !fork) return null
    if (!await server.handle('getSessionInfo', [fork.historySessionId ?? fork.sourceSessionId], handlerCtx)) {
      throw new Error('The fork source is no longer available.')
    }
    return readResponseForkPage(sessionRuntime, { sessionId, provider: record.provider, cwd: record.cwd, turnLimit, before, ...fork })
  }

  const historyOf = async (handlerCtx: HandlerCtx, agentId: AgentId, sessionId: string, projectPath?: string, limit?: number): Promise<WireSessionLoadMessage[]> => {
    if (isApiMode()) return readTranscript(recordScopeOf(handlerCtx.principal), sessionId, limit)
    let page = await forkHistory(handlerCtx, sessionId, 20)
    if (!page) return projectSessionHistory(storePromptImages(await sessionRuntime.history.loadSession(agentId, sessionId, projectPath, limit)))
    const pages: SessionLoadMessage[][] = []
    let rows = 0
    do {
      pages.push(page.messages)
      rows += page.messages.length
      if (!page.before || (limit && rows >= limit)) break
      page = await forkHistory(handlerCtx, sessionId, 20, page.before)
    } while (page)
    const messages = pages.reverse().flat()
    return projectSessionHistory(storePromptImages(limit ? messages.slice(-limit) : messages))
  }
  /** A session's activity for a history read (plans/012 §5), inside the window the read covers. */
  const sessionActivityOf = (handlerCtx: HandlerCtx, sessionId: string, window: ActivityWindow) =>
    activityFor(recordScopeOf(handlerCtx.principal), { kind: 'session', id: sessionId }, { window })
  /** A host's metadata with its record's organization, which tells a client
   *  where the session's record lives once this machine is gone
   *  (docs/plans/workspace-and-machines.md §6). The workspace service has only the record. */
  const withRecord = async (handlerCtx: HandlerCtx, sessionId: string, meta: SessionMeta | null): Promise<SessionMeta | null> => {
    const record = await getSessionRecord(recordScopeOf(handlerCtx.principal), sessionId)
    if (!meta) meta = record ? sessionMetaFromRecord(record) : null
    if (!meta) return null
    const storage = !isApiMode() ? readSessionStorage(sessionId) : null
    if (!isApiMode()) meta = { ...meta, head: storage?.head ?? null, syncedTurn: storage?.turnCount ?? 0, pushRefused: !!storage?.pushRefusedHead }
    if (!record) return meta
    const execution = await readSessionExecution(record.organizationId, sessionId, '')
    const described: SessionMeta = { ...meta, organizationId: record.organizationId, publication: record.publication, execution: execution ?? undefined }
    return described
  }
  const sessionInfoOf = async (handlerCtx: HandlerCtx, sessionId: string): Promise<SessionMeta | null> =>
    withRecord(handlerCtx, sessionId, await sessionRuntime.history.getSessionInfo(sessionId))

  // A session and the sessions below it (docs/plans/session-digests.md), read in
  // the session's own organization, as its artifacts are.
  server.register('sessionTree', async (args, ctx) => {
    const [sessionId, includeRelations] = args
    const scope = await organizationOfSession(sessionId)
    const tree = await readSessionTree(scope, sessionId)
    if (includeRelations !== true) return tree
    const root = tree.nodes[0]?.record
    if (!root || root.sessionId !== sessionId) return tree
    const relations = await sessionTreeRelations(scope, root)
    const visible = await Promise.all(relations.map((relation) =>
      server.handle('getSessionInfo', [relation.sessionId], ctx).then(Boolean, () => false)))
    const links = relations.filter((_, index) => visible[index])
    const origin = hostStarterOf(root.startedBy)
    if (origin && origin.sessionId !== sessionId && !links.some((link) => link.sessionId === origin.sessionId)) {
      // The destination already shows these starter facts in its transcript.
      // Opening that session uses the reader's own connection on its host.
      links.unshift({
        kind: 'parent', sessionId: origin.sessionId, title: origin.hostLabel,
        runnerHostId: null, hostLabel: origin.hostLabel,
      })
    }
    return { ...tree, relations: links }
  })

  // The collaboration plane's session records (docs/plans/cloud-service-model.md).

  server.register('sessionRecordUpsert', async (args, ctx) => {
    const [record] = args
    // A runner's report names the runner; it cannot speak for another host. Its new record is its person's.
    const organizationId = organizationForNew(ctx.principal)
    return ctx.principal.kind === 'runner'
      ? upsertSessionRecord(organizationId, { ...record, runnerHostId: ctx.principal.hostId }, { organizationId, ownerKey: ctx.principal.ownerUserId })
      : upsertSessionRecord(organizationId, record)
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

  server.register('trackRecentProject', async (args, ctx) => {
    const [path] = args
    try {
      await trackRecentProject(path)
      // A person opened the folder as a project: a container is a codebase from now on (docs/plans/codebases.md decision 14).
      if (path && path !== '~') await formContainerCodebases(path, ctx.actor)
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
      const messages = mergeWindowActivity(history, await sessionActivityOf(handlerCtx, sessionId, historyWindow(history, !!limit)), !!limit)
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

  const manifests = new HistoryPageManifests()
  server.register('loadSessionPage', async ([input], handlerCtx) => {
    const startedAt = Date.now()
    const request = z.object({
      sessionId: z.string().min(1),
      provider: agentIdSchema,
      projectPath: z.string().optional(),
      turnLimit: z.number().int().min(1).max(100),
      before: z.string().max(16384).optional(),
      deferArtifactHtml: z.boolean().optional(),
      replyLayout: z.boolean().optional(), promptFiles: z.boolean().optional(), turnItems: z.boolean().optional(),
      throughEntryId: z.string().min(1).max(16384).optional(),
      openSession: z.boolean().optional(),
      watchIfHistoryRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      knownHistoryBlocks: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(128).optional(),
    }).parse(input)
    const resumeWatch = async (page: SessionHistoryPage): Promise<SessionHistoryPage> => {
      if (request.before || request.throughEntryId || mirrored) return page
      if (request.openSession) {
        const openingDescription = await server.handle('describeSession', [request.sessionId], handlerCtx)
        page = { ...page, openingDescription }
      } else if (!request.watchIfHistoryRevision || request.watchIfHistoryRevision !== page.historyRevision || page.messages.length) {
        return page
      }
      if (sessionRuntime.activeSessions.has(request.sessionId) || sessionRuntime.activeRunRequests.has(request.sessionId) ||
          sessionRuntime.launcher.pendingSetupControllers.has(request.sessionId)) return page
      const resumedWatch = await server.handle('watchSession', [{ sessionId: request.sessionId, attachRuntime: true }], handlerCtx)
      return { ...page, resumedWatch }
    }
    const profileStartedAt = performance.now()
    const cursor = readActivityPageCursor(request.before)
    const mirrored = isApiMode()
    const source = await readHistoryThroughEntry(async before => {
      if (mirrored) return readTranscriptPage(recordScopeOf(handlerCtx.principal), request.sessionId, request.turnLimit, before)
      return await forkHistory(handlerCtx, request.sessionId, request.turnLimit, before)
        ?? sessionRuntime.history.loadSessionPage({ ...request, before })
    }, cursor.before, request.throughEntryId)
    const historyReadyAt = performance.now()
    const activity = await sessionActivityOf(handlerCtx, request.sessionId, pageWindow(source, cursor.at))
    // Preview measurements can change without an edit to a provider row.
    const hasRender = request.replyLayout && source.messages.some(row => row.role === 'assistant' && /(?:`{3,}|~{3,})[ \t]*html\b/i.test(row.content))
    const key = !hasRender && request.knownHistoryBlocks && manifests.sourceKey(
      (mirrored ? 'mirror' : request.provider) + (request.replyLayout ? ':layout' : '') + (request.promptFiles ? ':files' : '') + (request.turnItems ? ':items' : ''), request.sessionId, !!request.deferArtifactHtml, cursor.at, source, activity)
    if (key && request.knownHistoryBlocks) {
      const resumed = manifests.resume(key, request.knownHistoryBlocks)
      if (resumed) {
        recordOtelDuration('load_session_page', Date.now() - startedAt, { provider: request.provider, count: 0 })
        return resumeWatch(resumed)
      }
    }
    const page = mirrored ? source : { ...source, messages: projectSessionHistory(storePromptImages(source.messages)) }
    const { messages, before } = mergePageActivity(page, activity, cursor.at)
    const activityReadyAt = performance.now()
    recordOtelDuration('load_session_page', Date.now() - startedAt, { provider: request.provider, count: messages.length })
    log.info('session_history_page_loaded', {
      sessionId: request.sessionId, provider: request.provider, messageCount: messages.length,
      olderPage: !!request.before, hasMore: page.before !== null, durationMs: Date.now() - startedAt,
    })
    const current = withExchangeProgress(messages, exchangeProgress)
    const full = {
      messages: deferSessionToolInputs(request.deferArtifactHtml ? deferSavedArtifactHtml(current) : current),
      before,
    }
    if (request.promptFiles) full.messages = projectPromptFiles(full.messages)
    if (hasRender) full.messages = await withReplyHtmlLayouts(full.messages)
    if (request.replyLayout) full.messages = await withArtifactLayouts(full.messages)
    if (request.turnItems) full.messages = withTurnItemBodies(full.messages)
    const result = request.knownHistoryBlocks ? resumeHistoryPage(full, request.knownHistoryBlocks) : full
    if (key) manifests.remember(key, result, full.messages)
    const preparedAt = performance.now()
    const bytes = isDebugEnabled() ? serializedBytes(result) : undefined
    log.info('session_history_response_profile', {
      sessionId: request.sessionId, provider: request.provider, olderPage: !!request.before,
      messageCount: result.messages.length, bytes,
      historyAndProjectionMs: historyReadyAt - profileStartedAt,
      activityMs: activityReadyAt - historyReadyAt,
      preparationMs: preparedAt - activityReadyAt,
      sizeMeasurementMs: performance.now() - preparedAt,
      durationMs: preparedAt - profileStartedAt,
    })
    return resumeWatch(result)
  })

  server.register('loadSessionSubagent', async ([input]) => {
    const request = z.object({
      sessionId: z.string().min(1).max(200),
      toolId: z.string().min(1).max(512),
      provider: agentIdSchema,
      projectPath: z.string().max(16384).optional(),
      before: z.string().max(16384).optional(),
    }).strict().parse(input)
    // Provider files live on the execution host; a mirrored record has no child transcript.
    if (isApiMode()) throw new Error('Connect to the session host to read provider child history.')
    const page = await sessionRuntime.history.loadSessionSubagent(request)
    return {
      messages: deferSessionToolInputs(projectSessionHistory(storePromptImages(page.messages))),
      before: page.before,
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

  // Any reader of the session may report: a height is cosmetic, and the frame
  // corrects it the moment its own render reports.
  server.register('artifactFrameHeightReport', async ([input]) => {
    const report = z.strictObject({
      sessionId: z.string().min(1).max(200),
      attachmentId: z.string().regex(/^[a-f0-9]{64}$/),
      width: z.number().int().min(120).max(4096),
      height: z.number().int().min(1).max(20_000),
    }).parse(input)
    await recordArtifactFrameHeight(report.attachmentId, report.width, report.height)
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

  server.register('loadSessionMessageWindow', async (args, ctx) => {
    const [request] = args
    try {
      return isApiMode()
        ? await readTranscriptMessageWindow(recordScopeOf(ctx.principal), request)
        : getSessionMessageWindow(request.sessionId, request.messageId, request.radius, request.target)
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
      return { ...description, meta: await withRecord(handlerCtx, sessionId, description.meta) }
    } catch (err) {
      log.error('describe_session_failed', { error: String(err), sessionId })
      return { lineage: null, meta: null }
    }
  })

  server.register('generateSessionMetadata', async (args, ctx) => {
    const [promptText, cwd, context] = args
    // The run uses the caller's own provider login, as their turns do.
    const organizationId = context?.sessionId ? await organizationOfSession(context.sessionId) : LOCAL_ORGANIZATION_ID
    // The caller's own writing model, from this host's copy of their preferences.
    return generateSessionMetadata(sessionRuntime, promptText, cwd, context, (provider) => sessionRuntime.seatForTurn(ctx.actor, provider), organizationId, actingPreferences(organizationId))
  })

  server.register('ensureBackgroundSessionTitle', async (args, ctx) => {
    const [sessionId] = args
    return ensureBackgroundSessionTitle(sessionRuntime, events, {
      sessionId,
      // The preferences the session's run carried; else the caller's, from this host's copy.
      preferences: await sessionExecutionPreferences(sessionId) ?? actingPreferences(await organizationOfSession(sessionId)),
      actor: ctx.actor,
    })
  })

  server.register('setSessionTitle', async (args, ctx) => {
    const [sessionId, title, source = 'manual', generatedDescription, publishEvent = true] = args
    await renameSession(sessionRuntime, events, {
      sessionId, title, source, generatedDescription, publishEvent, actor: ctx.actor, scope: recordScopeOf(ctx.principal),
    })
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
      const by = attributionOf(ctx.actor)
      await saveAnnotations(recordScopeOf(ctx.principal), { ...annotations, comments: stampComments(annotations.comments, by) }, by)
      sessionRuntime.history.invalidatePlanCaches(annotations.sessionId)
      // Every open copy of the plan, the sender's included, re-reads the threads the host now holds.
      notifyAnnotationsChanged({ kind: 'plan', targetId: `${annotations.sessionId}__${annotations.planToolUseId}` })
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

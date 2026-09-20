import { isWorkspaceMode } from '../workspace-mode'
import { exportWorkForCloud, importWorkFromHost, removePushedWork } from '../../folio/works'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { readWorkExternalComments, refreshWorkExternalComments, sendWorkExternalComment } from '../../folio/work-comments'
import type { SolusServer } from '../server'
import { createWork, duplicateWork, saveWork, loadWork, listWorks, deleteWork, agentSaveWork, loadWorkPrevious, revertWork, setWorkPinned, linkWorkSession } from '../../folio/works'
import { expandHome } from './lib/host-path'
import { applyWorkComment, loadWorkAnnotations } from '../../folio/work-annotations'
import { workCommentCommandSchema, type CommentActor } from '@solus/contracts/comment-commands'
import { turnAuthorFor } from '../../presence/presence-manager'
import { isHostAdmin, organizationOf, type Principal } from '../principal'
import { importDocFromUrl, publishWork, pullWorkUpstream, refreshUpstreamState, unlinkWork } from '../../folio/work-sync'
import { docProviderAdapter, docProviderStatuses } from '../../docs/registry'
import { publishPlan, pullPlanUpstream, refreshPlanUpstream, unlinkPlanUpstream } from '../../plans/plan-sync'
import type { Work } from '@solus/contracts/types'
import type { ShareManager } from '../../sharing/share-manager'
import { Task } from '../../tasks/task'
import { createLogger } from '../../logger'

const log = createLogger('main', 'folio-handlers')

async function linkWorkToSessionTasks(organizationId: string, work: Work): Promise<void> {
  const sessionIds = work.sessionIds ?? (work.sessionId ? [work.sessionId] : [])
  await Promise.all(sessionIds.map((sessionId) => Task.linkArtifactForSession(organizationId, sessionId, {
    kind: 'work',
    targetKey: work.id,
    title: work.title,
  }).catch((error) => {
    log.warn('task_work_link_failed', {
      sessionId,
      workId: work.id,
      error: error instanceof Error ? error.message : String(error),
    })
  })))
}

export function registerFolioHandlers(server: SolusServer, deps: { shares?: ShareManager } = {}): void {
  server.register('readWorkGoogleComments', (args, ctx) => readWorkExternalComments(organizationOf(ctx.principal), args[0]))
  server.register('refreshWorkGoogleComments', (args, ctx) => refreshWorkExternalComments(organizationOf(ctx.principal), args[0]))
  server.register('sendWorkGoogleComment', (args, ctx) => sendWorkExternalComment(organizationOf(ctx.principal), args[0], args[1]))
  server.register('readWorkExternalComments', (args, ctx) => readWorkExternalComments(organizationOf(ctx.principal), args[0]))
  server.register('refreshWorkExternalComments', (args, ctx) => refreshWorkExternalComments(organizationOf(ctx.principal), args[0]))
  server.register('sendWorkExternalComment', (args, ctx) => sendWorkExternalComment(organizationOf(ctx.principal), args[0], args[1]))
  server.register('createWork', async (args, ctx) => {
    const [title, type, content, preview, sessionId, agentProvider, cwd, id] = args
    const organizationId = organizationOf(ctx.principal)
    if (id && await loadWork(organizationId, id)) throw new Error('This work already exists. Open its cloud copy instead.')
    const work = await createWork(organizationId, title, type, content, preview, sessionId, agentProvider, cwd, id)
    // The person who made the work owns it (docs/plans/multiplayer-sharing.md §3.4).
    await deps.shares?.claimOwner({ kind: 'work', id: work.id }, ctx.principal)
    await linkWorkToSessionTasks(organizationId, work)
    return work
  })

  server.register('saveWork', async (args, ctx) => {
    const [id, updates] = args
    const organizationId = organizationOf(ctx.principal)
    const work = await saveWork(organizationId, id, updates)
    await linkWorkToSessionTasks(organizationId, work)
    return work
  })

  server.register('loadWork', async (args, ctx) => {
    const [id] = args
    return loadWork(organizationOf(ctx.principal), id)
  })

  server.register('listWorks', async (_args, ctx) => {
    const works = await listWorks(organizationOf(ctx.principal))
    // A list never returns an id the caller cannot open (§3.7).
    return deps.shares ? deps.shares.filterVisible(ctx.principal, 'work', works, (work) => work.id) : works
  })

  server.register('worksCloudExport', (args, ctx) => exportWorkForCloud(organizationOf(ctx.principal), args[0]))
  server.register('worksCloudImport', async (args, ctx) => {
    if (!isWorkspaceMode()) throw new Error('A cloud push needs the workspace service.')
    const organizationId = organizationOf(ctx.principal)
    const transfer = args[0]
    if (await loadWork(organizationId, transfer.work.id)) await deps.shares?.assertRole(ctx.principal, { kind: 'work', id: transfer.work.id }, 'owner')
    const work = await importWorkFromHost(organizationId, transfer)
    await deps.shares?.claimOwner({ kind: 'work', id: work.id }, ctx.principal)
    await linkWorkToSessionTasks(organizationId, work)
    return work
  })
  server.register('worksCloudRemove', async (args, ctx) => {
    if (isWorkspaceMode()) throw new Error('The cloud copy is the work’s home.')
    const organizationId = organizationOf(ctx.principal)
    await removePushedWork(organizationId, args[0], args[1])
    await deps.shares?.forget(organizationId, { kind: 'work', id: args[0] })
  })

  server.register('deleteWork', async (args, ctx) => {
    const [id] = args
    const organizationId = organizationOf(ctx.principal)
    await deleteWork(organizationId, id)
    await deps.shares?.forget(organizationId, { kind: 'work', id })
  })

  server.register('duplicateWork', async (args, ctx) => {
    const [id] = args
    return duplicateWork(organizationOf(ctx.principal), id)
  })

  server.register('linkWorkSession', async (args, ctx) => {
    const [id, sessionId] = args
    const organizationId = organizationOf(ctx.principal)
    await linkWorkSession(organizationId, id, sessionId)
    const work = await loadWork(organizationId, id)
    if (work) await linkWorkToSessionTasks(organizationId, work)
  })

  // Execution plane: the work's content lands on this machine's disk, as the
  // form it is already stored in. The row is untouched; the file is a copy.
  server.register('worksExport', async (args, ctx) => {
    const [request] = args
    const work = await loadWork(organizationOf(ctx.principal), request.workId)
    if (!work) throw new Error(`Work not found: ${request.workId}`)
    const path = expandHome(request.path)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, work.content, 'utf8')
    log.info('work_exported', { workId: work.id, type: work.type, path })
    return { path, bytes: Buffer.byteLength(work.content, 'utf8') }
  })

  server.register('loadWorkAnnotations', async (args, ctx) => {
    const [workId] = args
    return loadWorkAnnotations(organizationOf(ctx.principal), workId)
  })

  // Who is changing the threads, as the host knows them: the same identity that
  // names a prompt bubble, and the right to tidy other people's threads when the
  // caller owns the work or administers the host.
  const commentActor = async (principal: Principal, workId: string): Promise<CommentActor> => ({
    person: turnAuthorFor(principal),
    canModerate: isHostAdmin(principal) || (await deps.shares?.roleFor(principal, { kind: 'work', id: workId }) ?? 'owner') === 'owner',
    now: Date.now(),
  })

  server.register('applyWorkComment', async (args, ctx) => {
    const [workId, rawCommand] = args
    const command = workCommentCommandSchema.parse(rawCommand)
    return applyWorkComment(organizationOf(ctx.principal), workId, command, await commentActor(ctx.principal, workId))
  })

  server.register('markWorkCommentRead', async (args, ctx) => {
    const [workId, commentId] = args
    return applyWorkComment(organizationOf(ctx.principal), workId, { kind: 'read', commentId }, await commentActor(ctx.principal, workId))
  })

  server.register('agentSaveWork', async (args, ctx) => {
    const [id, updates] = args
    const organizationId = organizationOf(ctx.principal)
    const work = await agentSaveWork(organizationId, id, updates)
    await linkWorkToSessionTasks(organizationId, work)
    return work
  })

  server.register('loadWorkPrevious', async (args, ctx) => {
    const [id] = args
    return loadWorkPrevious(organizationOf(ctx.principal), id)
  })

  server.register('revertWork', async (args, ctx) => {
    const [id] = args
    const organizationId = organizationOf(ctx.principal)
    const work = await revertWork(organizationId, id)
    if (work) await linkWorkToSessionTasks(organizationId, work)
    return work
  })

  server.register('setWorkPinned', async (args, ctx) => {
    const [id, pinned] = args
    return setWorkPinned(organizationOf(ctx.principal), id, pinned)
  })

  // ─── Upstream doc mirror ───
  // The header actions and the agent tools call the same functions, so link
  // bookkeeping and the conflict guard cannot drift apart.

  server.register('docProviderStatuses', async () => docProviderStatuses())

  server.register('docDestinations', async (args) => {
    const [provider] = args
    return docProviderAdapter(provider).destinations()
  })

  server.register('publishWork', async (args, ctx) => {
    const [id, opts] = args
    return publishWork(organizationOf(ctx.principal), id, opts ?? {})
  })

  server.register('pullWorkUpstream', async (args, ctx) => {
    const [id] = args
    return pullWorkUpstream(organizationOf(ctx.principal), id)
  })

  server.register('refreshWorkUpstream', async (args, ctx) => {
    const [id] = args
    return refreshUpstreamState(organizationOf(ctx.principal), id)
  })

  server.register('unlinkWorkUpstream', async (args, ctx) => {
    const [id] = args
    return unlinkWork(organizationOf(ctx.principal), id)
  })

  server.register('publishPlan', async (args, ctx) => publishPlan(organizationOf(ctx.principal), args[0]))

  server.register('pullPlanUpstream', async (args, ctx) => pullPlanUpstream(organizationOf(ctx.principal), args[0], args[1]))

  server.register('refreshPlanUpstream', async (args, ctx) => refreshPlanUpstream(organizationOf(ctx.principal), args[0], args[1]))

  server.register('unlinkPlanUpstream', async (args, ctx) => unlinkPlanUpstream(organizationOf(ctx.principal), args[0], args[1]))

  server.register('importDocFromUrl', async (args, ctx) => {
    const [url, cwd] = args
    const imported = await importDocFromUrl(organizationOf(ctx.principal), url, { cwd })
    return imported.work
  })
}

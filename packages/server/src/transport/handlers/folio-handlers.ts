import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { readWorkExternalComments, refreshWorkExternalComments, sendWorkExternalComment } from '../../data/works/work-comments'
import type { SolusServer } from '../server'
import { duplicateWork, loadWork } from '../../data/works/works'
import { Work } from '../../data/works/work'
import { expandHome } from '../../files/host-path'
import { applyWorkComment, loadWorkAnnotations } from '../../data/works/work-annotations'
import { workCommentCommandSchema, type CommentActor } from '@solus/contracts/comment-commands'
import { attributionOf, type Actor } from '../../admission/actor'
import { isHostAdmin, organizationForNew, recordScopeOf } from '../../admission/principal'
import { importDocFromUrl, publishWork, pullWorkUpstream, refreshUpstreamState, unlinkWork } from '../../data/works/work-sync'
import { docProviderAdapter, docProviderStatuses } from '../../docs/registry'
import { publishPlan, pullPlanUpstream, refreshPlanUpstream, unlinkPlanUpstream } from '../../plans/plan-sync'
import type { ShareManager } from '../../sharing/share-manager'
import { linkWorkToSessionTasks } from '../../data/works/work-tasks'
import { createLogger } from '../../logger'

const log = createLogger('main', 'folio-handlers')

export function registerFolioHandlers(server: SolusServer, deps: { shares?: ShareManager } = {}): void {
  server.register('readWorkGoogleComments', (args, ctx) => readWorkExternalComments(recordScopeOf(ctx.principal), args[0]))
  server.register('refreshWorkGoogleComments', (args, ctx) => refreshWorkExternalComments(recordScopeOf(ctx.principal), args[0]))
  server.register('sendWorkGoogleComment', (args, ctx) => sendWorkExternalComment(recordScopeOf(ctx.principal), args[0], args[1]))
  server.register('readWorkExternalComments', (args, ctx) => readWorkExternalComments(recordScopeOf(ctx.principal), args[0]))
  server.register('refreshWorkExternalComments', (args, ctx) => refreshWorkExternalComments(recordScopeOf(ctx.principal), args[0]))
  server.register('sendWorkExternalComment', (args, ctx) => sendWorkExternalComment(recordScopeOf(ctx.principal), args[0], args[1]))

  server.register('duplicateWork', async (args, ctx) => {
    const [id] = args
    return duplicateWork(recordScopeOf(ctx.principal), id)
  })

  server.register('linkWorkSession', async (args, ctx) => {
    const [id, sessionId] = args
    const organizationId = recordScopeOf(ctx.principal)
    const work = await Work.find(organizationId, id)
    if (!work) return
    await work.linkSession(sessionId)
    await linkWorkToSessionTasks(organizationId, work.record())
  })

  // Execution plane: the work's content lands on this machine's disk, as the
  // form it is already stored in. The row is untouched; the file is a copy.
  server.register('worksExport', async (args, ctx) => {
    const [request] = args
    const work = await loadWork(recordScopeOf(ctx.principal), request.workId)
    if (!work) throw new Error(`Work not found: ${request.workId}`)
    const path = expandHome(request.path)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, work.content, 'utf8')
    log.info('work_exported', { workId: work.id, type: work.type, path })
    return { path, bytes: Buffer.byteLength(work.content, 'utf8') }
  })

  server.register('loadWorkAnnotations', async (args, ctx) => {
    const [workId] = args
    return loadWorkAnnotations(recordScopeOf(ctx.principal), workId)
  })

  // Who is changing the threads, as the host knows them: the same identity that
  // names a prompt bubble, and the right to tidy other people's threads when the
  // caller owns the work or administers the host.
  const commentActor = async (actor: Actor, workId: string): Promise<CommentActor> => ({
    by: attributionOf(actor),
    canModerate: isHostAdmin(actor.principal) || (await deps.shares?.roleFor(actor.principal, { kind: 'work', id: workId }) ?? 'owner') === 'owner',
    now: Date.now(),
  })

  server.register('applyWorkComment', async (args, ctx) => {
    const [workId, rawCommand] = args
    const command = workCommentCommandSchema.parse(rawCommand)
    return applyWorkComment(recordScopeOf(ctx.principal), workId, command, await commentActor(ctx.actor, workId))
  })

  server.register('markWorkCommentRead', async (args, ctx) => {
    const [workId, commentId] = args
    return applyWorkComment(recordScopeOf(ctx.principal), workId, { kind: 'read', commentId }, await commentActor(ctx.actor, workId))
  })

  // An agent save names the content version it read and no session: the RPC
  // is admitted as a principal, not as an agent turn, so the agent works for
  // that principal's person.
  server.register('agentSaveWork', async (args, ctx) => {
    const [id, updates, expectedContentVersion] = args
    const organizationId = recordScopeOf(ctx.principal)
    const work = await Work.byId(organizationId, id)
    if (updates.content !== undefined) await work.updateContent({ content: updates.content, title: updates.title, expectedContentVersion, author: attributionOf(ctx.actor, { sessionId: '' }), reason: 'agent' })
    else if (updates.title !== undefined) await work.updateTitle({ title: updates.title })
    await linkWorkToSessionTasks(organizationId, work.record())
    return work.record()
  })

  server.register('loadWorkRevisions', async (args, ctx) => {
    const [id] = args
    return (await Work.byId(recordScopeOf(ctx.principal), id)).revisions()
  })

  server.register('loadWorkRevision', async (args, ctx) => {
    const [id, revisionId] = args
    return (await Work.byId(recordScopeOf(ctx.principal), id)).revision(z.number().int().parse(revisionId))
  })

  // Restore any checkpoint as a new version. The displaced body is held by a
  // checkpoint first, so restoring that one undoes this restore.
  server.register('restoreWorkRevision', async (args, ctx) => {
    const [id, revisionId, expectedContentVersion] = args
    const organizationId = recordScopeOf(ctx.principal)
    const work = await Work.byId(organizationId, id)
    await work.restoreRevision({ revisionId: z.number().int().parse(revisionId), expectedContentVersion, author: attributionOf(ctx.actor) })
    await linkWorkToSessionTasks(organizationId, work.record())
    return work.record()
  })

  server.register('setWorkPinned', async (args, ctx) => {
    const [id, pinned] = args
    await (await Work.find(recordScopeOf(ctx.principal), id))?.setPinned(pinned)
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
    return publishWork(recordScopeOf(ctx.principal), id, opts ?? {})
  })

  server.register('pullWorkUpstream', async (args, ctx) => {
    const [id] = args
    return pullWorkUpstream(recordScopeOf(ctx.principal), id)
  })

  server.register('refreshWorkUpstream', async (args, ctx) => {
    const [id] = args
    return refreshUpstreamState(recordScopeOf(ctx.principal), id)
  })

  server.register('unlinkWorkUpstream', async (args, ctx) => {
    const [id] = args
    return unlinkWork(recordScopeOf(ctx.principal), id)
  })

  server.register('publishPlan', async (args, ctx) => publishPlan(recordScopeOf(ctx.principal), args[0]))

  server.register('pullPlanUpstream', async (args, ctx) => pullPlanUpstream(recordScopeOf(ctx.principal), args[0], args[1]))

  server.register('refreshPlanUpstream', async (args, ctx) => refreshPlanUpstream(recordScopeOf(ctx.principal), args[0], args[1]))

  server.register('unlinkPlanUpstream', async (args, ctx) => unlinkPlanUpstream(recordScopeOf(ctx.principal), args[0], args[1]))

  server.register('importDocFromUrl', async (args, ctx) => {
    const [url, cwd] = args
    const imported = await importDocFromUrl(organizationForNew(ctx.principal), url, { cwd })
    return imported.work
  })
}

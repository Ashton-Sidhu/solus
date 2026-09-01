import type { SolusServer } from '../server'
import { createWork, duplicateWork, saveWork, loadWork, listWorks, deleteWork, agentSaveWork, loadWorkPrevious, revertWork, setWorkPinned, promoteWorkToProject, linkWorkSession } from '../../folio/works'
import { loadWorkAnnotations, saveWorkAnnotations } from '../../folio/work-annotations'
import { importDocFromUrl, publishWork, pullWorkUpstream, refreshUpstreamState, unlinkWork } from '../../folio/work-sync'
import { docProviderAdapter, docProviderStatuses } from '../../docs/registry'
import { publishPlan, pullPlanUpstream, refreshPlanUpstream, unlinkPlanUpstream } from '../../plans/plan-sync'
import type { Work } from '@solus/contracts/types'
import { Task } from '../../tasks/task'
import { createLogger } from '../../logger'

const log = createLogger('main', 'folio-handlers')

async function linkWorkToSessionTasks(work: Work): Promise<void> {
  const sessionIds = work.sessionIds ?? (work.sessionId ? [work.sessionId] : [])
  await Promise.all(sessionIds.map((sessionId) => Task.linkArtifactForSession(sessionId, {
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

export function registerFolioHandlers(server: SolusServer): void {
  server.register('createWork', async (args) => {
    const [title, type, content, preview, sessionId, agentProvider, cwd, id] = args
    const work = await createWork(title, type, content, preview, sessionId, agentProvider, cwd, id)
    await linkWorkToSessionTasks(work)
    return work
  })

  server.register('saveWork', async (args) => {
    const [id, updates, cwd] = args
    const work = await saveWork(id, updates, cwd)
    await linkWorkToSessionTasks(work)
    return work
  })

  server.register('loadWork', async (args) => {
    const [id, cwd] = args
    return loadWork(id, cwd)
  })

  server.register('listWorks', async (args) => {
    const [cwd] = args
    return listWorks(cwd)
  })

  server.register('deleteWork', async (args) => {
    const [id, cwd] = args
    await deleteWork(id, cwd)
  })

  server.register('duplicateWork', async (args) => {
    const [id, cwd] = args
    return duplicateWork(id, cwd)
  })

  server.register('linkWorkSession', async (args) => {
    const [id, sessionId, cwd] = args
    await linkWorkSession(id, sessionId, cwd)
    const work = await loadWork(id, cwd)
    if (work) await linkWorkToSessionTasks(work)
  })

  server.register('loadWorkAnnotations', async (args) => {
    const [workId] = args
    return loadWorkAnnotations(workId)
  })

  server.register('saveWorkAnnotations', async (args) => {
    const [ann] = args
    return saveWorkAnnotations(ann)
  })

  server.register('agentSaveWork', async (args) => {
    const [id, updates, cwd] = args
    const work = await agentSaveWork(id, updates, cwd)
    await linkWorkToSessionTasks(work)
    return work
  })

  server.register('loadWorkPrevious', async (args) => {
    const [id, cwd] = args
    return loadWorkPrevious(id, cwd)
  })

  server.register('revertWork', async (args) => {
    const [id, cwd] = args
    const work = await revertWork(id, cwd)
    if (work) await linkWorkToSessionTasks(work)
    return work
  })

  server.register('setWorkPinned', async (args) => {
    const [id, pinned, cwd] = args
    return setWorkPinned(id, pinned, cwd)
  })

  server.register('promoteWorkToProject', async (args) => {
    const [id, projectRoot] = args
    return promoteWorkToProject(id, projectRoot)
  })

  // ─── Upstream doc mirror ───
  // The header actions and the agent tools call the same functions, so link
  // bookkeeping and the conflict guard cannot drift apart.

  server.register('docProviderStatuses', async () => docProviderStatuses())

  server.register('docDestinations', async (args) => {
    const [provider] = args
    return docProviderAdapter(provider).destinations()
  })

  server.register('publishWork', async (args) => {
    const [id, opts] = args
    return publishWork(id, opts ?? {})
  })

  server.register('pullWorkUpstream', async (args) => {
    const [id, cwd] = args
    return pullWorkUpstream(id, cwd)
  })

  server.register('refreshWorkUpstream', async (args) => {
    const [id, cwd] = args
    return refreshUpstreamState(id, cwd)
  })

  server.register('unlinkWorkUpstream', async (args) => {
    const [id, cwd] = args
    return unlinkWork(id, cwd)
  })

  server.register('publishPlan', async (args) => publishPlan(args[0]))

  server.register('pullPlanUpstream', async (args) => pullPlanUpstream(args[0], args[1]))

  server.register('refreshPlanUpstream', async (args) => refreshPlanUpstream(args[0], args[1]))

  server.register('unlinkPlanUpstream', async (args) => unlinkPlanUpstream(args[0], args[1]))

  server.register('importDocFromUrl', async (args) => {
    const [url, cwd] = args
    const imported = await importDocFromUrl(url, { cwd })
    return imported.work
  })
}

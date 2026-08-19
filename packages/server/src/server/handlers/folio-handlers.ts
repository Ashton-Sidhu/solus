import type { SolusServer } from '../server'
import { createWork, duplicateWork, saveWork, loadWork, listWorks, deleteWork, agentSaveWork, loadWorkPrevious, revertWork, setWorkPinned, promoteWorkToProject, linkWorkSession } from '../../folio/works'
import { loadWorkAnnotations, saveWorkAnnotations } from '../../folio/work-annotations'
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
}

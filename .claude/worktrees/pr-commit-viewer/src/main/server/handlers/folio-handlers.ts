import type { SolusServer } from '../server'
import { createWork, duplicateWork, saveWork, loadWork, listWorks, deleteWork, agentSaveWork, loadWorkPrevious, revertWork, setWorkPinned, promoteWorkToProject, linkWorkSession } from '../../folio/works'
import { loadWorkAnnotations, saveWorkAnnotations } from '../../folio/work-annotations'
import type { AgentId, Work, WorkAnnotations } from '../../../shared/types'
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
    const [title, type, content, preview, sessionId, agentProvider, cwd, id] = args as [string, 'doc' | 'slides' | 'diagram', string | undefined, string | undefined, string | undefined, AgentId, string | undefined, string | undefined]
    const work = await createWork(title, type, content, preview, sessionId, agentProvider, cwd, id)
    await linkWorkToSessionTasks(work)
    return work
  })

  server.register('saveWork', async (args) => {
    const [id, updates, cwd] = args as [string, Partial<Pick<Work, 'title' | 'preview' | 'content'>>, string | undefined]
    const work = await saveWork(id, updates, cwd)
    await linkWorkToSessionTasks(work)
    return work
  })

  server.register('loadWork', async (args) => {
    const [id, cwd] = args as [string, string | undefined]
    return loadWork(id, cwd)
  })

  server.register('listWorks', async (args) => {
    const [cwd] = args as [string | undefined]
    return listWorks(cwd)
  })

  server.register('deleteWork', async (args) => {
    const [id, cwd] = args as [string, string | undefined]
    await deleteWork(id, cwd)
  })

  server.register('duplicateWork', async (args) => {
    const [id, cwd] = args as [string, string | undefined]
    return duplicateWork(id, cwd)
  })

  server.register('linkWorkSession', async (args) => {
    const [id, sessionId, cwd] = args as [string, string, string | undefined]
    await linkWorkSession(id, sessionId, cwd)
    const work = await loadWork(id, cwd)
    if (work) await linkWorkToSessionTasks(work)
  })

  server.register('loadWorkAnnotations', async (args) => {
    const [workId] = args as [string]
    return loadWorkAnnotations(workId)
  })

  server.register('saveWorkAnnotations', async (args) => {
    const [ann] = args as [WorkAnnotations]
    return saveWorkAnnotations(ann)
  })

  server.register('agentSaveWork', async (args) => {
    const [id, updates, cwd] = args as [string, Partial<Pick<Work, 'title' | 'preview' | 'content'>>, string | undefined]
    const work = await agentSaveWork(id, updates, cwd)
    await linkWorkToSessionTasks(work)
    return work
  })

  server.register('loadWorkPrevious', async (args) => {
    const [id, cwd] = args as [string, string | undefined]
    return loadWorkPrevious(id, cwd)
  })

  server.register('revertWork', async (args) => {
    const [id, cwd] = args as [string, string | undefined]
    const work = await revertWork(id, cwd)
    if (work) await linkWorkToSessionTasks(work)
    return work
  })

  server.register('setWorkPinned', async (args) => {
    const [id, pinned, cwd] = args as [string, boolean, string | undefined]
    return setWorkPinned(id, pinned, cwd)
  })

  server.register('promoteWorkToProject', async (args) => {
    const [id, projectRoot] = args as [string, string]
    return promoteWorkToProject(id, projectRoot)
  })
}

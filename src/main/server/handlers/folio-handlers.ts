import type { SolusServer } from '../server'
import { createWork, duplicateWork, saveWork, loadWork, listWorks, deleteWork, agentSaveWork, loadWorkPrevious, revertWork, setWorkPinned, promoteWorkToProject, linkWorkSession } from '../../folio/works'
import { loadWorkAnnotations, saveWorkAnnotations } from '../../folio/work-annotations'
import type { AgentId, Work, WorkAnnotations } from '../../../shared/types'

export function registerFolioHandlers(server: SolusServer): void {
  server.register('createWork', async (args) => {
    const [title, type, content, preview, sessionId, agentProvider, cwd, id] = args as [string, 'doc' | 'slides' | 'diagram', string | undefined, string | undefined, string | undefined, AgentId, string | undefined, string | undefined]
    return createWork(title, type, content, preview, sessionId, agentProvider, cwd, id)
  })

  server.register('saveWork', async (args) => {
    const [id, updates, cwd] = args as [string, Partial<Pick<Work, 'title' | 'preview' | 'content'>>, string | undefined]
    return saveWork(id, updates, cwd)
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
    return agentSaveWork(id, updates, cwd)
  })

  server.register('loadWorkPrevious', async (args) => {
    const [id, cwd] = args as [string, string | undefined]
    return loadWorkPrevious(id, cwd)
  })

  server.register('revertWork', async (args) => {
    const [id, cwd] = args as [string, string | undefined]
    return revertWork(id, cwd)
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

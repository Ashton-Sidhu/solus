import { resolve } from 'node:path'
import { z } from 'zod'
import { codebaseListOptionsSchema, codebaseSchema, type Codebase, type TaskFolder } from '@solus/contracts/codebases'
import { HOST_USE, permissionsAllow } from '@solus/contracts/permissions'
import { permissionsFor } from '../../admission/access-policy'
import { ownerKeyOf } from '../../admission/actor'
import { getInstallationId } from '../../admission/auth'
import { organizationForNew, recordScopeOf } from '../../admission/principal'
import { getCodebase, listCodebases, saveCodebase } from '../../data/codebases/codebases'
import { assertPathInScope } from '../../data/sessions/guest-path-scope'
import { membersOf, scanFolder } from '../../files/codebase-members'
import { expandHome } from '../../files/host-path'
import { findTaskFolderContaining } from '../../git/task-folder-store'
import { hostUserKey } from '../../host/host-user'
import { createLogger } from '../../logger'
import type { SessionFolders } from '../../execution/sessions/session-folders'
import type { SessionTaskFolders } from '../../execution/sessions/session-task-folders'
import type { HandlerCtx, SolusServer } from '../server'

const log = createLogger('codebases', 'codebase-handlers.ts')

const codebaseIdSchema = z.string().min(1).max(200)
const sessionIdSchema = z.string().min(1).max(256)
const folderPathSchema = z.string().min(1).max(4096)

/**
 * The codebase that a session started from a different host brings with it
 * (docs/plans/codebases.md §6). This host saves the record, the newest copy
 * wins, and the answer is the id the new session starts with. A caller that
 * may not change the codebases of this host brings none. A record this host
 * cannot save does not stop the session: it starts with the id, and it has the
 * folders of the codebase when this host has a copy that the person can read.
 */
export async function receiveSessionCodebase(sent: Codebase | undefined, caller: Pick<HandlerCtx, 'principal' | 'actor'>): Promise<string | null> {
  if (sent === undefined || !permissionsAllow(permissionsFor(caller.principal), HOST_USE)) return null
  const codebase = codebaseSchema.parse(sent)
  try {
    await saveCodebase(organizationForNew(caller.principal), ownerKeyOf(caller.actor) ?? hostUserKey(), codebase)
  } catch (error) {
    log.warn('session_codebase_save_failed', { codebaseId: codebase.id, error: error instanceof Error ? error.message : String(error) })
  }
  return codebase.id
}

/**
 * Codebases (docs/plans/codebases.md §4 and §5). Each host keeps the full
 * record: a client sends the newest copy to each host that has an older one,
 * so a save answers the copy the host keeps. A client deletes with a save of
 * the tombstone, so each host gets the same `updatedAt`. The members of a
 * codebase are read from this host's disk and are not stored.
 */
export function registerCodebaseHandlers(
  server: SolusServer,
  sessionFolders: Pick<SessionFolders, 'read' | 'attach' | 'detach'>,
  taskFolders: Pick<SessionTaskFolders, 'addRepository' | 'candidates'>,
): void {
  server.register('codebaseList', ([options], ctx) => listCodebases(recordScopeOf(ctx.principal), codebaseListOptionsSchema.parse(options ?? {})))
  server.register('codebaseSave', ([codebase], ctx) => {
    return saveCodebase(organizationForNew(ctx.principal), ownerKeyOf(ctx.actor) ?? hostUserKey(), codebaseSchema.parse(codebase))
  })
  server.register('codebaseMembers', async ([codebaseId], ctx) => {
    const codebase = await getCodebase(recordScopeOf(ctx.principal), codebaseIdSchema.parse(codebaseId))
    if (!codebase || codebase.deletedAt !== null) throw new Error('This host has no copy of that codebase.')
    return membersOf(codebase, getInstallationId())
  })
  server.register('codebaseScanFolder', ([path], ctx) => {
    const clientPath = z.string().min(1).max(4096).parse(path)
    assertPathInScope('codebaseScanFolder', ctx.principal, expandHome(clientPath))
    return scanFolder(clientPath)
  })
  // The folders of a session (§6). A person attaches with no card: a card is for an agent that asks.
  server.register('sessionFolders', ([sessionId], ctx) => sessionFolders.read(sessionIdSchema.parse(sessionId), ctx.actor))
  server.register('sessionAttachFolder', ([sessionId, path], ctx) => {
    return sessionFolders.attach(sessionIdSchema.parse(sessionId), folderPathSchema.parse(path), 'attached', ctx.actor)
  })
  server.register('sessionDetachFolder', ([sessionId, path], ctx) => {
    return sessionFolders.detach(sessionIdSchema.parse(sessionId), folderPathSchema.parse(path), ctx.actor)
  })
  // The task folder of a worktree session of several repositories (§7).
  server.register('taskFolderOf', ([path], ctx): TaskFolder | null => {
    const folder = resolve(expandHome(folderPathSchema.parse(path)))
    assertPathInScope('taskFolderOf', ctx.principal, folder)
    const record = findTaskFolderContaining(folder)
    if (!record) return null
    // The codebase, the session, and the time of the record are for this host only.
    const { codebaseId: _codebaseId, sessionId: _sessionId, createdAt: _createdAt, ...taskFolder } = record
    return taskFolder
  })
  server.register('sessionAddRepositoryWorktree', ([sessionId, repositoryPath], ctx) => {
    return taskFolders.addRepository(sessionIdSchema.parse(sessionId), folderPathSchema.parse(repositoryPath), ctx.actor)
  })
  server.register('sessionWorktreeCandidates', ([sessionId], ctx) => taskFolders.candidates(sessionIdSchema.parse(sessionId), ctx.actor))
}

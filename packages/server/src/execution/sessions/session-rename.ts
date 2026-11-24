import type { SessionTitleChangedEvent } from '@solus/contracts/types'
import type { Actor, AgentVia } from '../../admission/actor'
import type { RecordScope } from '../../admission/principal'
import { getIndexedSession, setSessionCustomTitle } from '../../db/session-indexer'
import { emitSessionTasksChanged } from '../../data/tasks/task-sessions'
import { createLogger } from '../../logger'
import type { SessionRuntime } from '../session-runtime'
import type { SessionTitleBroadcaster } from './background-session-title'

const log = createLogger('main', 'session-rename.ts')

export interface SessionRenameRequest {
  sessionId: string
  /** Null or blank clears the custom name back to the opening prompt. */
  title: string | null | undefined
  source: SessionTitleChangedEvent['source']
  generatedDescription?: string
  publishEvent: boolean
  /** The person the rename is for. */
  actor: Actor
  /** The records the task refresh may read: the caller's. */
  scope: RecordScope
  /** The agent that renamed it for the person, when an agent did. */
  via?: AgentVia
}

/**
 * Names a session, for a person's client and for an agent's tool: the custom
 * name, the task rows that show it, every client, and the rename activity.
 */
export async function renameSession(runtime: SessionRuntime, events: SessionTitleBroadcaster, request: SessionRenameRequest): Promise<void> {
  const { sessionId, source, generatedDescription, actor } = request
  const trimmed = request.title?.trim()
  const customTitle = trimmed || null
  const previousTitle = getIndexedSession(sessionId)?.customTitle ?? null
  // The same name again changes nothing: no write, no task refresh, and no
  // broadcast that every client would answer with reads of its own. A
  // generated name still carries its description to the clients.
  if (customTitle === previousTitle && !generatedDescription) {
    log.debug('session_rename_unchanged', { sessionId })
    return
  }
  await setSessionCustomTitle(sessionId, customTitle)
  let taskCatalogChanged = false
  try {
    // Session names and task names have separate owners. The task snapshot
    // still needs a refresh because its attempt rows join this session
    // title, but naming one attempt must not rename the shared task.
    await emitSessionTasksChanged(request.scope, sessionId)
    taskCatalogChanged = true
  } catch (error) {
    log.warn('task_session_metadata_update_failed', { sessionId, error: String(error) })
  }
  if (request.publishEvent) {
    const event: SessionTitleChangedEvent = { sessionId, title: customTitle, source }
    if (generatedDescription) event.generatedDescription = generatedDescription
    await events.broadcast('session.titleChanged', event)
    // A person's rename is activity, so a teammate reads who did it, now and after a reload (plan 004 step 12).
    // Every client re-sends a name typed before the session had an id; the same name again is no rename.
    if (source === 'manual' && (actor.user || request.via) && customTitle !== previousTitle) {
      void runtime.recordActivity({ kind: 'session', id: sessionId }, actor, { kind: 'renamed', title: customTitle ?? '' }, undefined, request.via)
    }
  } else if (!taskCatalogChanged) {
    // The proxy row changed even when a generated task name lost a race to a
    // manual edit. Other clients of the task host still need to reload it.
    await emitSessionTasksChanged(request.scope, sessionId)
  }
  log.info('session_renamed', { sessionId, cleared: !trimmed, taskCatalogChanged })
}

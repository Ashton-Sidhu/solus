import type { ExecutionPreferences } from '@solus/contracts/settings'
import type { SessionMeta, SessionGeneratedMetadata, SessionTitleChangedEvent } from '@solus/contracts/types'
import type { Actor } from '../../admission/actor'
import { ANY_ORGANIZATION } from '../../admission/principal'
import { getIndexedSession, setSessionGeneratedTitle } from '../../db/session-indexer'
import { emitSessionTasksChanged } from '../../data/tasks/task-sessions'
import { renamePinnedSession } from '../../data/sessions/pinned-sessions'
import { createLogger } from '../../logger'
import type { SessionRuntime } from '../session-runtime'
import { generateSessionMetadata } from './session-title'

const log = createLogger('main', 'background-session-title')
const naming = new Map<string, Promise<string | null>>()

/** The one event naming sends. The host's event publisher answers it; Execution does not import Transport. */
export interface SessionTitleBroadcaster {
  broadcast(type: 'session.titleChanged', payload: SessionTitleChangedEvent): Promise<unknown>
}

/** Narrow domain operations; supplied directly by tests. */
export interface BackgroundSessionTitlePorts {
  read(sessionId: string): SessionMeta | null
  save(sessionId: string, title: string): Promise<boolean>
  generate(runtime: SessionRuntime, prompt: string, cwd: string, request: BackgroundSessionTitleRequest): Promise<SessionGeneratedMetadata | null>
  refresh(sessionId: string): Promise<void>
  renamePin(sessionId: string, title: string): void
}

const defaultPorts: BackgroundSessionTitlePorts = {
  read: getIndexedSession,
  save: setSessionGeneratedTitle,
  generate: (runtime, prompt, cwd, request) => generateSessionMetadata(runtime, prompt, cwd, {
    sessionId: request.sessionId,
    executionPreferences: request.preferences,
  }, (provider) => runtime.seatForTurn(request.actor, provider)),
  refresh: (sessionId) => emitSessionTasksChanged(ANY_ORGANIZATION, sessionId),
  renamePin: renamePinnedSession,
}

export interface BackgroundSessionTitleRequest {
  sessionId: string
  /** The name its starter gave it: saved as is, never generated. */
  title?: string
  prompt?: string
  cwd?: string
  preferences?: ExecutionPreferences
  actor?: Actor
}

/** Name one worker on its execution host. The indexed title is the authority. */
export function ensureBackgroundSessionTitle(
  runtime: SessionRuntime,
  events: SessionTitleBroadcaster,
  request: BackgroundSessionTitleRequest,
  ports: BackgroundSessionTitlePorts = defaultPorts,
): Promise<string | null> {
  const pending = naming.get(request.sessionId)
  if (pending) return pending
  const run = nameSession(runtime, events, request, ports).finally(() => naming.delete(request.sessionId))
  naming.set(request.sessionId, run)
  return run
}

/** A name made from the worker's prompt, unless its person turned that off. */
function generatedMetadata(
  runtime: SessionRuntime,
  request: BackgroundSessionTitleRequest,
  meta: SessionMeta,
  ports: BackgroundSessionTitlePorts,
): Promise<SessionGeneratedMetadata | null> {
  if (request.preferences?.autoRenameSessions === false) return Promise.resolve(null)
  const prompt = request.prompt?.trim() || meta.firstMessage?.trim()
  const cwd = request.cwd || meta.cwd
  if (!prompt || !cwd) return Promise.resolve(null)
  return ports.generate(runtime, prompt, cwd, request)
}

async function nameSession(
  runtime: SessionRuntime,
  events: SessionTitleBroadcaster,
  request: BackgroundSessionTitleRequest,
  ports: BackgroundSessionTitlePorts,
): Promise<string | null> {
  const meta = ports.read(request.sessionId)
  // A worker is named; so is any session its starter named.
  if (!meta || (!meta.delegation && !request.title)) return null
  if (meta.customTitle) return meta.customTitle
  const metadata: Pick<SessionGeneratedMetadata, 'title'> & Partial<SessionGeneratedMetadata> | null =
    request.title ? { title: request.title } : await generatedMetadata(runtime, request, meta, ports)
  if (!metadata) return null
  if (!await ports.save(request.sessionId, metadata.title)) {
    return ports.read(request.sessionId)?.customTitle ?? null
  }
  ports.renamePin(request.sessionId, metadata.title)
  await ports.refresh(request.sessionId).catch((error) => {
    log.warn('background_session_task_refresh_failed', { sessionId: request.sessionId, error: String(error) })
  })
  const event: SessionTitleChangedEvent = { sessionId: request.sessionId, title: metadata.title, source: 'generated' }
  if (metadata.description) event.generatedDescription = metadata.description
  await events.broadcast('session.titleChanged', event)
  log.info('background_session_named', { sessionId: request.sessionId })
  return metadata.title
}

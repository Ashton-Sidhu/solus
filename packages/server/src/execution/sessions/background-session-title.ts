import type { ExecutionPreferences } from '@solus/contracts/settings'
import type { SessionMeta, SessionGeneratedMetadata } from '@solus/contracts/types'
import type { Actor } from '../../admission/actor'
import { ANY_ORGANIZATION } from '../../admission/principal'
import { getIndexedSession, setSessionGeneratedTitle } from '../../db/session-indexer'
import { emitSessionTasksChanged } from '../../data/tasks/task-sessions'
import { renamePinnedSession } from '../../data/sessions/pinned-sessions'
import { createLogger } from '../../logger'
import type { HostEventPublisher } from '../../transport/events/host-event-publisher'
import type { SessionRuntime } from '../session-runtime'
import { generateSessionMetadata } from './session-title'

const log = createLogger('main', 'background-session-title')
const naming = new Map<string, Promise<string | null>>()

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
  prompt?: string
  cwd?: string
  preferences?: ExecutionPreferences
  actor?: Actor
}

/** Name one worker on its execution host. The indexed title is the authority. */
export function ensureBackgroundSessionTitle(
  runtime: SessionRuntime,
  events: HostEventPublisher,
  request: BackgroundSessionTitleRequest,
  ports: BackgroundSessionTitlePorts = defaultPorts,
): Promise<string | null> {
  const pending = naming.get(request.sessionId)
  if (pending) return pending
  const run = nameSession(runtime, events, request, ports).finally(() => naming.delete(request.sessionId))
  naming.set(request.sessionId, run)
  return run
}

async function nameSession(
  runtime: SessionRuntime,
  events: HostEventPublisher,
  request: BackgroundSessionTitleRequest,
  ports: BackgroundSessionTitlePorts,
): Promise<string | null> {
  const meta = ports.read(request.sessionId)
  if (!meta?.delegation) return null
  if (meta.customTitle) return meta.customTitle
  if (request.preferences?.autoRenameSessions === false) return null
  const prompt = request.prompt?.trim() || meta.firstMessage?.trim()
  const cwd = request.cwd || meta.cwd
  if (!prompt || !cwd) return null
  const metadata = await ports.generate(runtime, prompt, cwd, request)
  if (!metadata) return null
  if (!await ports.save(request.sessionId, metadata.title)) {
    return ports.read(request.sessionId)?.customTitle ?? null
  }
  ports.renamePin(request.sessionId, metadata.title)
  await ports.refresh(request.sessionId).catch((error) => {
    log.warn('background_session_task_refresh_failed', { sessionId: request.sessionId, error: String(error) })
  })
  await events.broadcast('session.titleChanged', {
    sessionId: request.sessionId,
    title: metadata.title,
    source: 'generated',
    generatedDescription: metadata.description,
  })
  log.info('background_session_named', { sessionId: request.sessionId })
  return metadata.title
}

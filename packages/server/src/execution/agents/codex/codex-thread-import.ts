import { resolveHomePath } from '../../../platform/paths'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { CodexAppServerClient } from './codex-agent'
import type { CodexThreadReadResponse } from './codex-protocol'
import { ensureImportedSessionLineage } from '../../../data/sessions/session-lineage'
import { importThreadFiles, safeThreadPath, type ThreadImportRequest, type ThreadImportResult } from '../thread-import'

/** Refresh the app-server projection after its rollout is current. This makes no model request. */
export async function importCodexThread(request: ThreadImportRequest, home: string, client: CodexAppServerClient): Promise<ThreadImportResult> {
  request.signal?.throwIfAborted()
  const cwd = resolveHomePath(request.cwd)
  if (request.files.length === 0) return { files: [], bytesWritten: 0 }
  const sessions = join(home, 'sessions')
  for (const file of request.files) {
    if (!file.relativePath.startsWith('sessions/')) throw new Error(`File is outside Codex sessions: ${file.relativePath}`)
    safeThreadPath(home, file.relativePath)
  }
  const statePath = await codexStatePath(client, request.threadId)
  if (statePath) {
    const within = relative(sessions, statePath)
    if (!isAbsolute(statePath) || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error('Codex state path is outside this seat home')
    if (request.files.length !== 1) throw new Error('Codex state path is ambiguous for multiple rollout files')
  }
  request.signal?.throwIfAborted()
  try { await client.request('thread/unsubscribe', { threadId: request.threadId }) }
  catch (error) {
    if (!(error instanceof Error) || !/thread not loaded|thread not found|unknown thread/i.test(error.message)) throw error
  }
  ensureImportedSessionLineage({ sessionId: request.sessionId, provider: 'codex', threadId: request.threadId, cwd })
  const files = statePath
    ? [{ path: request.files[0].path, relativePath: relative(home, statePath).split(sep).join('/') }]
    : request.files
  const result = await importThreadFiles(home, files, request.signal, request.replaceConflicts)
  if (statePath) result.files[0].relativePath = request.files[0].relativePath
  if (result.files.some((file) => file.status === 'conflict')) return result
  request.signal?.throwIfAborted()
  await client.request('thread/resume', { threadId: request.threadId, cwd })
  return result
}

async function codexStatePath(client: CodexAppServerClient, threadId: string): Promise<string | null> {
  try {
    const response = await client.request<CodexThreadReadResponse>('thread/read', { threadId, includeTurns: false })
    return response.thread.path ?? null
  } catch (error) {
    if (error instanceof Error && /thread not found|unknown thread|not loaded/i.test(error.message)) return null
    throw error
  }
}

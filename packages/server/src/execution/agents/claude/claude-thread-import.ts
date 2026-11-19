import { resolveHomePath } from '../../../platform/paths'
import { join } from 'node:path'
import { encodePathAsFolder } from '../utils'
import { ensureImportedSessionLineage } from '../../../data/sessions/session-lineage'
import { importThreadFiles, type ThreadImportRequest, type ThreadImportResult } from '../thread-import'

/** Import into the project folder Claude will use for the next turn. */
export async function importClaudeThread(
  request: ThreadImportRequest, home: string, writeFiles = importThreadFiles,
): Promise<ThreadImportResult> {
  request.signal?.throwIfAborted()
  const cwd = resolveHomePath(request.cwd)
  const root = join(home, 'projects', encodePathAsFolder(cwd))
  for (const file of request.files) {
    const main = `${request.threadId}.jsonl`
    if (file.relativePath !== main && !file.relativePath.startsWith(`${request.threadId}/`)) throw new Error(`File is outside Claude thread: ${file.relativePath}`)
  }
  ensureImportedSessionLineage({ sessionId: request.sessionId, provider: 'claude-code', threadId: request.threadId, cwd })
  return writeFiles(root, request.files, request.signal)
}

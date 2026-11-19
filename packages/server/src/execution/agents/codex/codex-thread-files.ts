import { basename } from 'node:path'
import type { ThreadFile } from '../../../sync/sessions/session-archive-writer'

/**
 * The rollout file of a Codex thread as a thread file of the session
 * repository (docs/plans/portable-sessions.md §5). Codex keeps rollouts under
 * `<CODEX_HOME>/sessions/<year>/<month>/<day>/`, and another host must write
 * the file at the same place under its own home, so the relative path starts
 * at `sessions`. `path` is an unstable field of the app-server protocol: a
 * runtime that does not report it gives no file.
 */
export function codexThreadFiles(rolloutPath: string | null | undefined): ThreadFile[] {
  if (!rolloutPath) return []
  const segments = rolloutPath.split(/[\\/]/)
  const sessionsAt = segments.lastIndexOf('sessions')
  const relativePath = sessionsAt === -1 ? basename(rolloutPath) : segments.slice(sessionsAt).join('/')
  return [{ key: 'rollout', relativePath, path: rolloutPath }]
}

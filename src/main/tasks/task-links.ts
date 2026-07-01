import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createLogger } from '../logger'
import { writeJson } from '../project-config/json-file'
import { resolveProjectKey } from '../project-config/project-config'
import type { TaskSessionLink } from '../../shared/task-types'

const log = createLogger('main', 'task-links')

// task ↔ session links are a Solus-local concept (the relationship between a
// ticket and the agent run working on it), so they live in our own store rather
// than being written upstream — that keeps GitHub authoritative for content and
// works identically for the local provider. Mirrors the bound-work model, but
// the reverse map (task → sessions) is the durable bit: a session's `boundTaskId`
// is renderer state that resets on reload, whereas this survives so the card can
// always show "has an active session" and link back to it.
const ROOT = join(homedir(), '.solus', 'tasks', 'links')

interface LinkStore {
  version: 1
  /** task id → the sessions started from it (most-recent last). */
  links: Record<string, TaskSessionLink[]>
}

function storePath(projectKey: string): string {
  return join(ROOT, `${projectKey}.json`)
}

async function read(projectKey: string): Promise<LinkStore> {
  const path = storePath(projectKey)
  if (!existsSync(path)) return { version: 1, links: {} }
  try {
    return JSON.parse(await readFile(path, 'utf8')) as LinkStore
  } catch (err) {
    log.error(`read(${projectKey}) failed: ${String(err)}`)
    return { version: 1, links: {} }
  }
}

/** Record that `sessionId` was started from `taskId` in this project. Idempotent
 *  — re-linking the same pair just refreshes its timestamp so ordering stays
 *  most-recent-last. */
export async function linkTaskSession(cwd: string, taskId: string, sessionId: string): Promise<void> {
  const projectKey = resolveProjectKey(cwd)
  const store = await read(projectKey)
  const list = store.links[taskId] ?? []
  const existing = list.find((l) => l.sessionId === sessionId)
  if (existing) existing.linkedAt = Date.now()
  else list.push({ sessionId, linkedAt: Date.now() })
  store.links[taskId] = list
  await writeJson(storePath(projectKey), store)
}

/** All task → session links for a project, so the renderer can mark which tasks
 *  have live work and offer a jump-back. Empty when nothing's been linked yet. */
export async function taskSessions(cwd: string): Promise<Record<string, TaskSessionLink[]>> {
  const store = await read(resolveProjectKey(cwd))
  return store.links
}

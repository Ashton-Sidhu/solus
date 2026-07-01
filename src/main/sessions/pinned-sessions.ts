import { createLogger } from "../logger"
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import type { PinnedSession, PinnedSessionManifest } from "../../shared/types"

const log = createLogger('sessions', 'pinned-sessions.ts')
const ROOT = join(homedir(), '.solus')
const MANIFEST_PATH = join(ROOT, 'pinned-sessions.json')

async function ensureDir(): Promise<void> {
  if (!existsSync(ROOT)) {
    await mkdir(ROOT, { recursive: true })
  }
}

/** Pinned sessions, most-recently-pinned first. */
export async function readManifest(): Promise<PinnedSession[]> {
  if (!existsSync(MANIFEST_PATH)) return []
  try {
    const text = await readFile(MANIFEST_PATH, 'utf8')
    const manifest = JSON.parse(text) as PinnedSessionManifest
    return Object.values(manifest.sessions).sort((a, b) => b.pinnedAt - a.pinnedAt)
  } catch (err) {
    log.warn(`Failed to read pinned-sessions manifest, starting empty: ${err}`)
    return []
  }
}

async function writeManifest(sessions: PinnedSession[]): Promise<void> {
  await ensureDir()
  const manifest: PinnedSessionManifest = {
    sessions: Object.fromEntries(sessions.map((s) => [s.sessionId, s])),
  }
  await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8')
}

export async function togglePinnedSession(session: PinnedSession): Promise<PinnedSession[]> {
  const sessions = await readManifest()
  const next = sessions.some((s) => s.sessionId === session.sessionId)
    ? sessions.filter((s) => s.sessionId !== session.sessionId)
    : [session, ...sessions] // newest pinnedAt first keeps the list sorted
  await writeManifest(next)
  return next
}

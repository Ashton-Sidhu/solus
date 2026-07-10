import { watch, type FSWatcher } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import type { SessionMeta, SessionSearchResult } from '../../shared/types'
import { SOLUS_WORKTREE_ENCODED_MARKER } from '../../shared/types'
import { readSessionHeadMeta } from '../agents/claude/claude-session-helpers'
import { createLogger } from '../logger'
import { getDb, withTx } from './index'

const log = createLogger('main', 'session-indexer')
const PROJECTS_ROOT = join(homedir(), '.claude', 'projects')
const WATCH_DEBOUNCE_MS = 2_000
const LINES_PER_TRANSACTION = 300

interface SessionRow {
  session_id: string
  cwd: string | null
  project_path: string | null
  is_worktree: number | null
  slug: string | null
  first_message: string | null
  last_timestamp: number | null
  size: number | null
}

interface IndexedMessage {
  endOffset: number
  uuid: string | null
  role: string
  ts: number | null
  text: string
}

let watcher: FSWatcher | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let ready = false
let generation = 0
let fullSweepPending = false
let sweepQueue = Promise.resolve()
const changedPaths = new Set<string>()

function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

async function readTail(filePath: string, offset: number, size: number): Promise<Buffer> {
  const fh = await open(filePath, 'r')
  const tail = Buffer.allocUnsafe(size - offset)
  let totalRead = 0
  try {
    while (totalRead < tail.length) {
      const { bytesRead } = await fh.read(tail, totalRead, tail.length - totalRead, offset + totalRead)
      if (bytesRead === 0) break
      totalRead += bytesRead
    }
  } finally {
    await fh.close()
  }
  return tail.subarray(0, totalRead)
}

function deleteSessionFile(filePath: string): void {
  const sessionId = basename(filePath, '.jsonl')
  withTx(() => {
    const db = getDb()
    db.prepare('DELETE FROM session_fts WHERE rowid IN (SELECT id FROM session_messages WHERE session_id = ?)').run(sessionId)
    db.prepare('DELETE FROM session_messages WHERE session_id = ?').run(sessionId)
    db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId)
    db.prepare('DELETE FROM session_files WHERE path = ?').run(filePath)
  })
}

function resetSession(filePath: string, sessionId: string, size: number, mtime: number): void {
  withTx(() => {
    const db = getDb()
    db.prepare('DELETE FROM session_fts WHERE rowid IN (SELECT id FROM session_messages WHERE session_id = ?)').run(sessionId)
    db.prepare('DELETE FROM session_messages WHERE session_id = ?').run(sessionId)
    db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId)
    db.prepare(`
      INSERT INTO session_files(path, provider, size, mtime, last_offset, indexed_at)
      VALUES (?, 'claude', ?, ?, 0, ?)
      ON CONFLICT(path) DO UPDATE SET
        provider = excluded.provider,
        size = excluded.size,
        mtime = excluded.mtime,
        last_offset = 0,
        indexed_at = excluded.indexed_at
    `).run(filePath, size, mtime, Date.now())
  })
}

function extractMessage(line: string, endOffset: number): IndexedMessage | null {
  try {
    const obj = JSON.parse(line)
    if ((obj.type !== 'user' && obj.type !== 'assistant') || !obj.message) return null

    const content = obj.message.content
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
          .filter((item: any) => item?.type === 'text' && typeof item.text === 'string')
          .map((item: any) => item.text)
          .join('\n')
        : ''
    if (!text.trim()) return null

    const parsedTs = new Date(obj.timestamp).getTime()
    return {
      endOffset,
      uuid: typeof obj.uuid === 'string' ? obj.uuid : null,
      role: typeof obj.message.role === 'string' ? obj.message.role : obj.type,
      ts: Number.isFinite(parsedTs) ? parsedTs : null,
      text,
    }
  } catch {
    return null
  }
}

function upsertSession(
  sessionId: string,
  cwd: string | null,
  projectPath: string,
  isWorktree: boolean,
  slug: string | null,
  firstMessage: string | null,
  lastTimestamp: number,
  size: number,
): void {
  const db = getDb()
  const count = db.prepare('SELECT COUNT(*) AS count FROM session_messages WHERE session_id = ?')
    .get(sessionId) as { count: number }
  db.prepare(`
    INSERT INTO sessions(
      session_id, provider, cwd, project_path, project_key, is_worktree,
      slug, first_message, last_timestamp, message_count, size
    )
    VALUES (?, 'claude', ?, ?, NULL, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      provider = excluded.provider,
      cwd = excluded.cwd,
      project_path = excluded.project_path,
      project_key = excluded.project_key,
      is_worktree = excluded.is_worktree,
      slug = excluded.slug,
      first_message = excluded.first_message,
      last_timestamp = excluded.last_timestamp,
      message_count = excluded.message_count,
      size = excluded.size
  `).run(
    sessionId,
    cwd,
    projectPath,
    isWorktree ? 1 : 0,
    slug,
    firstMessage,
    lastTimestamp,
    count.count,
    size,
  )
}

async function indexFile(filePath: string, activeGeneration: number): Promise<void> {
  let fileStat
  try {
    fileStat = await stat(filePath)
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      if (activeGeneration === generation) deleteSessionFile(filePath)
      return
    }
    throw error
  }
  if (activeGeneration !== generation || !fileStat.isFile()) return

  const db = getDb()
  const tracked = db.prepare('SELECT last_offset FROM session_files WHERE path = ?')
    .get(filePath) as { last_offset: number } | undefined
  const lastOffset = tracked?.last_offset ?? 0
  if (fileStat.size === lastOffset) return

  const sessionId = basename(filePath, '.jsonl')
  const mtime = Math.trunc(fileStat.mtimeMs)
  if (fileStat.size < 100) {
    resetSession(filePath, sessionId, fileStat.size, mtime)
    return
  }
  if (!tracked || fileStat.size < lastOffset) {
    resetSession(filePath, sessionId, fileStat.size, mtime)
  }
  const readOffset = !tracked || fileStat.size < lastOffset ? 0 : lastOffset
  const meta = await readSessionHeadMeta(filePath)
  if (activeGeneration !== generation) return
  if (!meta.validated) {
    resetSession(filePath, sessionId, fileStat.size, mtime)
    getDb().prepare(`
      UPDATE session_files
      SET last_offset = ?, indexed_at = ?
      WHERE path = ?
    `).run(fileStat.size, Date.now(), filePath)
    return
  }

  const tail = await readTail(filePath, readOffset, fileStat.size)
  if (activeGeneration !== generation) return

  const projectPath = relative(PROJECTS_ROOT, filePath).split(/[\\/]/)[0] || basename(dirname(filePath))
  const isWorktree = projectPath.includes(SOLUS_WORKTREE_ENCODED_MARKER)
  const records: Array<{ endOffset: number; message: IndexedMessage | null }> = []
  let lineStart = 0
  while (lineStart < tail.length) {
    const newline = tail.indexOf(0x0a, lineStart)
    const lineEnd = newline === -1 ? tail.length : newline
    const endOffset = readOffset + (newline === -1 ? lineEnd : lineEnd + 1)
    const line = tail.subarray(lineStart, lineEnd).toString('utf8').replace(/\r$/, '')
    const message = extractMessage(line, endOffset)
    if (newline === -1 && !message) {
      try {
        JSON.parse(line)
      } catch {
        break
      }
    }
    records.push({ endOffset, message })
    lineStart = lineEnd + 1
  }

  if (records.length === 0) {
    withTx(() => {
      upsertSession(
        sessionId,
        meta.cwd,
        projectPath,
        isWorktree,
        meta.slug,
        meta.firstMessage,
        mtime,
        fileStat.size,
      )
      getDb().prepare(`
        UPDATE session_files
        SET size = ?, mtime = ?, last_offset = ?, indexed_at = ?
        WHERE path = ?
      `).run(fileStat.size, mtime, readOffset, Date.now(), filePath)
    })
    return
  }

  for (let index = 0; index < records.length; index += LINES_PER_TRANSACTION) {
    if (activeGeneration !== generation) return
    const chunk = records.slice(index, index + LINES_PER_TRANSACTION)
    const isFinalChunk = index + LINES_PER_TRANSACTION >= records.length
    withTx(() => {
      const openedDb = getDb()
      const insertMessage = openedDb.prepare(`
        INSERT INTO session_messages(session_id, uuid, role, ts, text)
        VALUES (?, ?, ?, ?, ?)
      `)
      const insertFts = openedDb.prepare('INSERT INTO session_fts(rowid, text) VALUES (?, ?)')
      for (const record of chunk) {
        if (!record.message) continue
        const result = insertMessage.run(
          sessionId,
          record.message.uuid,
          record.message.role,
          record.message.ts,
          record.message.text,
        )
        insertFts.run(result.lastInsertRowid, record.message.text)
      }
      if (isFinalChunk) {
        upsertSession(
          sessionId,
          meta.cwd,
          projectPath,
          isWorktree,
          meta.slug,
          meta.firstMessage,
          mtime,
          fileStat.size,
        )
      }
      openedDb.prepare(`
        UPDATE session_files
        SET size = ?, mtime = ?, last_offset = ?, indexed_at = ?
        WHERE path = ?
      `).run(fileStat.size, mtime, chunk.at(-1)!.endOffset, Date.now(), filePath)
    })
    await yieldToMain()
  }
}

async function listTranscriptFiles(activeGeneration: number): Promise<string[]> {
  const files: string[] = []
  const pending = [PROJECTS_ROOT]
  while (pending.length > 0 && activeGeneration === generation) {
    const dir = pending.pop()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error: any) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    for (const entry of entries) {
      const entryPath = join(dir, entry.name)
      if (entry.isDirectory()) pending.push(entryPath)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(entryPath)
    }
    await yieldToMain()
  }
  return files
}

async function sweepAll(activeGeneration: number): Promise<void> {
  const files = await listTranscriptFiles(activeGeneration)
  if (activeGeneration !== generation) return
  const seen = new Set(files)
  for (const filePath of files) {
    try {
      await indexFile(filePath, activeGeneration)
    } catch (error) {
      log.warn(`Failed to index ${filePath}: ${error}`)
    }
    await yieldToMain()
  }
  if (activeGeneration !== generation) return

  const tracked = getDb().prepare("SELECT path FROM session_files WHERE provider = 'claude'").all() as Array<{ path: string }>
  for (const { path } of tracked) {
    if (!seen.has(path)) deleteSessionFile(path)
  }
}

function scheduleSweep(filename: string | Buffer | null): void {
  if (filename) {
    const relativePath = filename.toString()
    if (relativePath.endsWith('.jsonl')) changedPaths.add(join(PROJECTS_ROOT, relativePath))
    else fullSweepPending = true
  } else {
    fullSweepPending = true
  }
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    const activeGeneration = generation
    const paths = [...changedPaths]
    changedPaths.clear()
    const runFullSweep = fullSweepPending
    fullSweepPending = false
    sweepQueue = sweepQueue
      .catch(() => {})
      .then(() => runFullSweep
        ? sweepAll(activeGeneration)
        : paths.reduce(
          (promise, filePath) => promise.then(() => indexFile(filePath, activeGeneration)),
          Promise.resolve(),
        ))
    void sweepQueue.catch((error) => log.warn(`Session index sweep failed: ${error}`))
  }, WATCH_DEBOUNCE_MS)
}

function installWatcher(): void {
  try {
    watcher = watch(PROJECTS_ROOT, { recursive: true }, (_event, filename) => scheduleSweep(filename))
    watcher.on('error', (error) => log.warn(`Session index watcher failed: ${error}`))
  } catch (error: any) {
    if (error?.code !== 'ENOENT') log.warn(`Unable to watch Claude sessions: ${error}`)
  }
}

export function startSessionIndexer(): void {
  stopSessionIndexer()
  const activeGeneration = generation
  ready = false
  void sweepAll(activeGeneration)
    .catch((error) => log.warn(`Initial session index sweep failed: ${error}`))
    .finally(() => {
      if (activeGeneration !== generation) return
      ready = true
      installWatcher()
    })
}

export function stopSessionIndexer(): void {
  generation++
  ready = false
  watcher?.close()
  watcher = null
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = null
  changedPaths.clear()
  fullSweepPending = false
}

export function sessionIndexReady(): boolean {
  return ready
}

function rowToSession(row: SessionRow): SessionMeta {
  return {
    provider: 'claude-code',
    sessionId: row.session_id,
    slug: row.slug,
    firstMessage: row.first_message,
    lastTimestamp: new Date(row.last_timestamp ?? 0).toISOString(),
    size: row.size ?? 0,
    cwd: row.cwd ?? '',
    projectPath: row.project_path ?? '',
    isWorktree: row.is_worktree === 1,
  }
}

export function listIndexedSessions(projectPaths: string[]): SessionMeta[] {
  if (projectPaths.length === 0) return []
  const placeholders = projectPaths.map(() => '?').join(', ')
  const rows = getDb().prepare(`
    SELECT session_id, cwd, project_path, is_worktree, slug, first_message, last_timestamp, size
    FROM sessions
    WHERE provider = 'claude' AND project_path IN (${placeholders})
    ORDER BY last_timestamp DESC
  `).all(...projectPaths) as unknown as SessionRow[]
  return rows.map(rowToSession)
}

function sanitizeFtsQuery(query: string): string {
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => `"${token.replaceAll('"', '""')}"`)
    .join(' ')
}

export function searchIndexedSessions(
  query: string,
  projectPath?: string,
  requestedLimit?: number,
): SessionSearchResult[] {
  const ftsQuery = sanitizeFtsQuery(query)
  if (!ftsQuery) return []
  const rawLimit = requestedLimit ?? 50
  const limit = Number.isFinite(rawLimit) ? Math.min(50, Math.max(1, Math.trunc(rawLimit))) : 50
  const projectFilter = projectPath ? 'AND s.project_path = ?' : ''
  const params: Array<string | number> = [ftsQuery]
  if (projectPath) params.push(projectPath)
  params.push(limit)

  const rows = getDb().prepare(`
    WITH hits AS MATERIALIZED (
      SELECT
        s.session_id,
        s.cwd,
        s.project_path,
        s.is_worktree,
        s.slug,
        s.first_message,
        s.last_timestamp,
        s.size,
        snippet(session_fts, 0, '', '', '…', 24) AS snippet,
        session_messages.id AS message_id,
        session_messages.ts AS hit_ts,
        bm25(session_fts) AS rank
      FROM session_fts
      JOIN session_messages ON session_messages.id = session_fts.rowid
      JOIN sessions s ON s.session_id = session_messages.session_id
      WHERE session_fts MATCH ? AND s.provider = 'claude'
      ${projectFilter}
    )
    SELECT *
    FROM hits
    WHERE message_id = (
      SELECT candidate.message_id
      FROM hits candidate
      WHERE candidate.session_id = hits.session_id
      ORDER BY candidate.rank ASC, candidate.hit_ts DESC
      LIMIT 1
    )
    ORDER BY rank ASC
    LIMIT ?
  `).all(...params) as unknown as Array<SessionRow & { snippet: string; hit_ts: number | null }>

  return rows.map((row) => ({
    session: rowToSession(row),
    snippet: row.snippet,
    ts: row.hit_ts ?? 0,
  }))
}

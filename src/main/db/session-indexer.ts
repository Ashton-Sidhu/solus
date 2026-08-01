import { watch, type FSWatcher } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import type { SessionLoadMessage } from '../../shared/session-history'
import type { AgentId, ReasoningEffort, SessionMeta, SessionSearchResult } from '../../shared/types'
import {
  encodePathAsFolder,
  isSolusWorktreePath,
  SOLUS_WORKTREE_ENCODED_MARKER,
  worktreeProjectRoot,
} from '../../shared/types'
import { readSessionHeadMeta } from '../agents/claude/claude-session-helpers'
import { createLogger } from '../logger'
import { sanitizeFtsQuery } from './fts'
import { getDb, withTx } from './index'

const log = createLogger('main', 'session-indexer')
const PROJECTS_ROOT = join(homedir(), '.claude', 'projects')
const WATCH_DEBOUNCE_MS = 2_000
const LINES_PER_TRANSACTION = 300
const READ_CHUNK_BYTES = 256 * 1024
export const MAX_INDEXED_SESSION_LINE_BYTES = 4 * 1024 * 1024
const CODEX_SESSION_WATERMARK_KEY = 'codex-session-index-watermark'

interface SessionRow {
  session_id: string
  provider: string
  cwd: string | null
  project_path: string | null
  is_worktree: number | null
  slug: string | null
  first_message: string | null
  last_timestamp: number | null
  size: number | null
  model: string | null
  reasoning_effort: string | null
  project_root: string | null
}

/** The git-root that groups a repo with all its worktrees. Pure path op:
 *  Solus worktrees collapse to their originating project; everything else is
 *  its own root. (Sub-directory cwds aren't lifted to the repo root here — the
 *  simple rule the whole index shares so a repo and its worktrees agree.) */
function projectRootFor(cwd: string | null): string | null {
  return cwd ? worktreeProjectRoot(cwd) : null
}

interface IndexedMessage {
  endOffset: number
  uuid: string | null
  role: string
  ts: number | null
  text: string
}

type StoredMessage = Omit<IndexedMessage, 'endOffset'>

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

function deleteSessionFile(filePath: string): void {
  const sessionId = basename(filePath, '.jsonl')
  withTx(() => {
    const db = getDb()
    db.prepare('DELETE FROM session_fts WHERE rowid IN (SELECT id FROM session_messages WHERE session_id = ?)').run(sessionId)
    db.prepare('DELETE FROM session_messages WHERE session_id = ?').run(sessionId)
    db.prepare(`
      DELETE FROM sessions
      WHERE session_id = ? AND model IS NULL AND reasoning_effort IS NULL
    `).run(sessionId)
    db.prepare('DELETE FROM session_files WHERE path = ?').run(filePath)
  })
}

/** Clear a file's message index so it re-reads from offset 0. The sessions row
 *  is deliberately left alone: re-indexing upserts over it, and deleting it here
 *  would race the model-config write from session_init that promptSession needs
 *  to re-launch a non-resident session. De-listing a session is a separate
 *  concern owned by deleteSessionFile and the sidechain branch of indexFile. */
export function resetSession(filePath: string, sessionId: string, size: number, mtime: number): void {
  withTx(() => {
    const db = getDb()
    db.prepare('DELETE FROM session_fts WHERE rowid IN (SELECT id FROM session_messages WHERE session_id = ?)').run(sessionId)
    db.prepare('DELETE FROM session_messages WHERE session_id = ?').run(sessionId)
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

/**
 * Stream complete JSONL records from the unread portion of a transcript.
 *
 * A session can grow to hundreds of megabytes. Reading its entire unread tail
 * used to retain both that Buffer and a second array containing every parsed
 * line until indexing began. Chunking here bounds the reader's working set to
 * one 256 KiB block plus the current line; callers separately bound parsed
 * records to one database transaction.
 */
export async function* readTailRecordBatches(
  filePath: string,
  offset: number,
  size: number,
): AsyncGenerator<Array<{ endOffset: number; message: IndexedMessage | null }>> {
  const file = await open(filePath, 'r')
  let position = offset
  let pendingChunks: Buffer[] = []
  let pendingLength = 0
  let skippingOversizedLine = false
  let records: Array<{ endOffset: number; message: IndexedMessage | null }> = []

  const parseLine = (lineBuffer: Buffer, endOffset: number): IndexedMessage | null => {
    const withoutCarriageReturn = lineBuffer.at(-1) === 0x0d
      ? lineBuffer.subarray(0, lineBuffer.length - 1)
      : lineBuffer
    return extractMessage(withoutCarriageReturn.toString('utf8'), endOffset)
  }

  try {
    while (position < size) {
      const requestedBytes = Math.min(READ_CHUNK_BYTES, size - position)
      const buffer = Buffer.allocUnsafe(requestedBytes)
      const { bytesRead } = await file.read(buffer, 0, requestedBytes, position)
      if (bytesRead === 0) break

      const chunk = buffer.subarray(0, bytesRead)
      let lineStart = 0
      while (lineStart < chunk.length) {
        const newline = chunk.indexOf(0x0a, lineStart)
        if (skippingOversizedLine) {
          if (newline === -1) {
            lineStart = chunk.length
            break
          }
          const endOffset = position + newline + 1
          records.push({ endOffset, message: null })
          if (records.length >= LINES_PER_TRANSACTION) {
            yield records
            records = []
          }
          skippingOversizedLine = false
          lineStart = newline + 1
          continue
        }
        if (newline === -1) break

        const segment = chunk.subarray(lineStart, newline)
        const endOffset = position + newline + 1
        if (pendingLength + segment.length > MAX_INDEXED_SESSION_LINE_BYTES) {
          records.push({ endOffset, message: null })
        } else {
          const lineBuffer = pendingLength === 0
            ? segment
            : Buffer.concat([...pendingChunks, segment], pendingLength + segment.length)
          records.push({ endOffset, message: parseLine(lineBuffer, endOffset) })
        }
        if (records.length >= LINES_PER_TRANSACTION) {
          yield records
          records = []
        }
        pendingChunks = []
        pendingLength = 0
        lineStart = newline + 1
      }

      if (lineStart < chunk.length) {
        const remainder = chunk.subarray(lineStart)
        if (pendingLength + remainder.length > MAX_INDEXED_SESSION_LINE_BYTES) {
          pendingChunks = []
          pendingLength = 0
          skippingOversizedLine = true
        } else {
          pendingChunks.push(remainder)
          pendingLength += remainder.length
        }
      }
      position += bytesRead
    }

    if (!skippingOversizedLine && pendingLength > 0) {
      const lineBuffer = pendingChunks.length === 1
        ? pendingChunks[0]
        : Buffer.concat(pendingChunks, pendingLength)
      const endOffset = position
      const message = parseLine(lineBuffer, endOffset)
      if (message) {
        records.push({ endOffset, message })
      } else {
        const withoutCarriageReturn = lineBuffer.at(-1) === 0x0d
          ? lineBuffer.subarray(0, lineBuffer.length - 1)
          : lineBuffer
        try {
          JSON.parse(withoutCarriageReturn.toString('utf8'))
          records.push({ endOffset, message: null })
        } catch {
          // The agent may still be writing the final line. Leave the offset at
          // the preceding newline so the completed record is read next sweep.
        }
      }
    }
    if (records.length > 0) yield records
  } finally {
    await file.close()
  }
}

function insertSessionMessageRows(
  sessionId: string,
  messages: Iterable<StoredMessage | null>,
): number {
  const db = getDb()
  const insertMessage = db.prepare(`
    INSERT INTO session_messages(session_id, uuid, role, ts, text)
    VALUES (?, ?, ?, ?, ?)
  `)
  const insertFts = db.prepare('INSERT INTO session_fts(rowid, text) VALUES (?, ?)')
  let inserted = 0
  for (const message of messages) {
    if (!message) continue
    const result = insertMessage.run(
      sessionId,
      message.uuid,
      message.role,
      message.ts,
      message.text,
    )
    insertFts.run(result.lastInsertRowid, message.text)
    inserted += 1
  }
  return inserted
}

export function indexSessionMessages(
  sessionId: string,
  provider: string,
  messages: SessionLoadMessage[],
): void {
  const storedMessages = messages
    .filter((message) =>
      (message.role === 'user' || message.role === 'assistant') &&
      message.content.trim(),
    )
    .map((message): StoredMessage => ({
      uuid: null,
      role: message.role,
      ts: Number.isFinite(message.timestamp) ? message.timestamp : null,
      text: message.content,
    }))

  withTx(() => {
    const db = getDb()
    db.prepare('DELETE FROM session_fts WHERE rowid IN (SELECT id FROM session_messages WHERE session_id = ?)').run(sessionId)
    db.prepare('DELETE FROM session_messages WHERE session_id = ?').run(sessionId)
    const messageCount = insertSessionMessageRows(sessionId, storedMessages)
    db.prepare(`
      UPDATE sessions
      SET message_count = ?
      WHERE session_id = ? AND provider = ?
    `).run(messageCount, sessionId, provider)
  })
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
      session_id, provider, cwd, project_path, project_key, project_root, is_worktree,
      slug, first_message, last_timestamp, message_count, size
    )
    VALUES (?, 'claude', ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      provider = excluded.provider,
      cwd = excluded.cwd,
      project_path = excluded.project_path,
      project_key = excluded.project_key,
      project_root = excluded.project_root,
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
    projectRootFor(cwd),
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
  if (!meta.validated || meta.isSidechain) {
    resetSession(filePath, sessionId, fileStat.size, mtime)
    // De-list sidechain/unparseable files — but a session file mid-write can
    // transiently fail head validation, so (like deleteSessionFile) never drop
    // a row carrying the model config persisted at session_init.
    getDb().prepare(`
      DELETE FROM sessions
      WHERE session_id = ? AND model IS NULL AND reasoning_effort IS NULL
    `).run(sessionId)
    getDb().prepare(`
      UPDATE session_files
      SET last_offset = ?, indexed_at = ?
      WHERE path = ?
    `).run(fileStat.size, Date.now(), filePath)
    return
  }

  const projectPath = relative(PROJECTS_ROOT, filePath).split(/[\\/]/)[0] || basename(dirname(filePath))
  const isWorktree = projectPath.includes(SOLUS_WORKTREE_ENCODED_MARKER)
  let lastIndexedOffset = readOffset

  for await (const records of readTailRecordBatches(filePath, readOffset, fileStat.size)) {
    if (activeGeneration !== generation) return
    lastIndexedOffset = records.at(-1)!.endOffset
    withTx(() => {
      const openedDb = getDb()
      insertSessionMessageRows(sessionId, records.map((record) => record.message))
      openedDb.prepare(`
        UPDATE session_files
        SET size = ?, mtime = ?, last_offset = ?, indexed_at = ?
        WHERE path = ?
      `).run(fileStat.size, mtime, lastIndexedOffset, Date.now(), filePath)
    })
    await yieldToMain()
  }
  if (activeGeneration !== generation) return

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
    `).run(fileStat.size, mtime, lastIndexedOffset, Date.now(), filePath)
  })
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
      if (entry.isDirectory()) {
        // `<sessionId>/subagents/` holds Task-tool sidechain transcripts, not real sessions.
        if (entry.name === 'subagents') continue
        pending.push(entryPath)
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(entryPath)
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
      log.warn('session_index_file_failed', { filePath, error: error instanceof Error ? error.message : String(error) })
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
    if (relativePath.split(/[\\/]/).includes('subagents')) {
      // Sidechain transcript for a Task-tool subagent, not a real session.
    } else if (relativePath.endsWith('.jsonl')) {
      changedPaths.add(join(PROJECTS_ROOT, relativePath))
    } else {
      fullSweepPending = true
    }
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
    void sweepQueue.catch((error) => log.warn('session_index_sweep_failed', { error: error instanceof Error ? error.message : String(error) }))
  }, WATCH_DEBOUNCE_MS)
}

function installWatcher(): void {
  try {
    watcher = watch(PROJECTS_ROOT, { recursive: true }, (_event, filename) => scheduleSweep(filename))
    watcher.on('error', (error) => log.warn('session_index_watcher_failed', { error: error instanceof Error ? error.message : String(error) }))
  } catch (error: any) {
    if (error?.code !== 'ENOENT') log.warn('session_index_watch_unavailable', { error: error instanceof Error ? error.message : String(error) })
  }
}

export function startSessionIndexer(): void {
  stopSessionIndexer()
  const activeGeneration = generation
  ready = false
  void sweepAll(activeGeneration)
    .catch((error) => log.warn('session_index_initial_sweep_failed', { error: error instanceof Error ? error.message : String(error) }))
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
    provider: row.provider === 'claude' ? 'claude-code' : (row.provider as AgentId),
    sessionId: row.session_id,
    slug: row.slug,
    firstMessage: row.first_message,
    lastTimestamp: new Date(row.last_timestamp ?? 0).toISOString(),
    size: row.size ?? 0,
    cwd: row.cwd ?? '',
    projectPath: row.project_path ?? '',
    isWorktree: row.is_worktree === 1,
    model: row.model ?? undefined,
    reasoningEffort: (row.reasoning_effort as SessionMeta['reasoningEffort']) ?? undefined,
    projectRoot: row.project_root ?? undefined,
  }
}

const SESSION_SELECT = `
  session_id, provider, cwd, project_path, is_worktree, slug, first_message,
  last_timestamp, size, model, reasoning_effort, project_root
`

export function getIndexedSession(sessionId: string): SessionMeta | null {
  const row = getDb().prepare(`SELECT ${SESSION_SELECT} FROM sessions WHERE session_id = ?`).get(sessionId) as SessionRow | undefined
  return row ? rowToSession(row) : null
}

export function getSessionMessages(sessionId: string): Array<{ role: string; ts: number | null; text: string }> {
  return getDb().prepare(`
    SELECT role, ts, text
    FROM session_messages
    WHERE session_id = ?
    ORDER BY ts ASC, id ASC
  `).all(sessionId) as Array<{ role: string; ts: number | null; text: string }>
}

export function persistIndexedSessionStart(
  sessionId: string,
  provider: AgentId,
  cwd: string,
  projectPath: string,
  model: string,
  reasoningEffort: ReasoningEffort,
): void {
  getDb().prepare(`
    INSERT INTO sessions(
      session_id, provider, cwd, project_path, project_key, project_root, is_worktree,
      slug, first_message, last_timestamp, message_count, size, model, reasoning_effort
    )
    VALUES (?, ?, ?, ?, NULL, ?, ?, NULL, NULL, ?, 0, 0, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      project_root = COALESCE(sessions.project_root, excluded.project_root),
      model = COALESCE(sessions.model, excluded.model),
      reasoning_effort = COALESCE(sessions.reasoning_effort, excluded.reasoning_effort)
  `).run(
    sessionId,
    provider === 'claude-code' ? 'claude' : provider,
    cwd,
    projectPath,
    projectRootFor(cwd),
    projectPath.includes(SOLUS_WORKTREE_ENCODED_MARKER) ? 1 : 0,
    Date.now(),
    model,
    reasoningEffort,
  )
}

export function listIndexedSessions(projectPaths: string[], limit?: number): SessionMeta[] {
  if (projectPaths.length === 0) return []
  const placeholders = projectPaths.map(() => '?').join(', ')
  const rows = getDb().prepare(`
    SELECT ${SESSION_SELECT}
    FROM sessions
    WHERE provider = 'claude' AND project_path IN (${placeholders})
    ORDER BY last_timestamp DESC
    ${limit === undefined ? '' : 'LIMIT ?'}
  `).all(...projectPaths, ...(limit === undefined ? [] : [limit])) as unknown as SessionRow[]
  return rows.map(rowToSession)
}

export function listIndexedCodexSessions(projectPath: string, limit?: number): SessionMeta[] {
  const normalizedPath = projectPath.replace(/\/$/, '')
  const encodedPath = encodePathAsFolder(normalizedPath)
  const includeWorktrees = !isSolusWorktreePath(normalizedPath)
  const rows = getDb().prepare(`
    SELECT ${SESSION_SELECT}
    FROM sessions
    WHERE provider = 'codex'
      AND (project_path = ?${includeWorktrees ? ' OR project_path LIKE ?' : ''})
    ORDER BY last_timestamp DESC
    ${limit === undefined ? '' : 'LIMIT ?'}
  `).all(
    encodedPath,
    ...(includeWorktrees ? [`${encodedPath}${SOLUS_WORKTREE_ENCODED_MARKER}%`] : []),
    ...(limit === undefined ? [] : [limit]),
  ) as unknown as SessionRow[]
  return rows.map(rowToSession)
}

export function cacheIndexedSessions(sessions: SessionMeta[]): void {
  if (sessions.length === 0) return
  withTx(() => {
    const upsert = getDb().prepare(`
      INSERT INTO sessions(
        session_id, provider, cwd, project_path, project_key, project_root, is_worktree,
        slug, first_message, last_timestamp, message_count, size
      )
      VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 0, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        provider = excluded.provider,
        cwd = excluded.cwd,
        project_path = excluded.project_path,
        project_root = excluded.project_root,
        is_worktree = excluded.is_worktree,
        slug = excluded.slug,
        first_message = excluded.first_message,
        last_timestamp = excluded.last_timestamp,
        size = excluded.size
    `)
    for (const session of sessions) {
      upsert.run(
        session.sessionId,
        session.provider === 'claude-code' ? 'claude' : session.provider,
        session.cwd,
        session.projectPath,
        projectRootFor(session.cwd),
        session.isWorktree ? 1 : 0,
        session.slug,
        session.firstMessage,
        new Date(session.lastTimestamp).getTime(),
        session.size,
      )
    }
  })
}

export function getCodexSessionIndexWatermark(): number | null {
  const row = getDb().prepare('SELECT value FROM kv WHERE key = ?')
    .get(CODEX_SESSION_WATERMARK_KEY) as { value: string } | undefined
  if (!row) return null
  const value = Number(row.value)
  return Number.isFinite(value) ? value : null
}

export function setCodexSessionIndexWatermark(timestamp: number): void {
  getDb().prepare(`
    INSERT INTO kv(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(CODEX_SESSION_WATERMARK_KEY, String(timestamp))
}

export function getIndexedCodexSessionTimestamps(sessionIds: string[]): Map<string, number> {
  const timestamps = new Map<string, number>()
  for (let offset = 0; offset < sessionIds.length; offset += 500) {
    const batch = sessionIds.slice(offset, offset + 500)
    const placeholders = batch.map(() => '?').join(', ')
    const rows = getDb().prepare(`
      SELECT session_id, last_timestamp
      FROM sessions
      WHERE provider = 'codex' AND session_id IN (${placeholders})
    `).all(...batch) as unknown as Array<{ session_id: string; last_timestamp: number | null }>
    for (const row of rows) timestamps.set(row.session_id, row.last_timestamp ?? 0)
  }
  return timestamps
}

/** Of the given session ids, the subset that already have at least one indexed
 *  message body. Lets the Codex refresh re-read threads whose row exists but
 *  whose body was never indexed (e.g. a session written at session_init), rather
 *  than trusting the last_timestamp comparison alone. */
export function getCodexSessionsWithMessages(sessionIds: string[]): Set<string> {
  const withMessages = new Set<string>()
  for (let offset = 0; offset < sessionIds.length; offset += 500) {
    const batch = sessionIds.slice(offset, offset + 500)
    const placeholders = batch.map(() => '?').join(', ')
    const rows = getDb().prepare(`
      SELECT DISTINCT session_id
      FROM session_messages
      WHERE session_id IN (${placeholders})
    `).all(...batch) as unknown as Array<{ session_id: string }>
    for (const row of rows) withMessages.add(row.session_id)
  }
  return withMessages
}

export function searchIndexedSessions(
  query: string,
  filters: {
    providers?: string[]
    role?: 'user' | 'assistant'
    /** Inclusive lower/upper bounds on message timestamp (ms). Omit for open-ended. */
    sinceTs?: number
    untilTs?: number
    /** Omit to search every project; set to scope to one git-root and all its worktrees. */
    projectRoot?: string
  } = {},
  requestedLimit?: number,
): SessionSearchResult[] {
  const ftsQuery = sanitizeFtsQuery(query)
  if (!ftsQuery) return []
  const rawLimit = requestedLimit ?? 50
  const limit = Number.isFinite(rawLimit) ? Math.min(50, Math.max(1, Math.trunc(rawLimit))) : 50
  const providers = filters.providers?.map((provider) => provider === 'claude-code' ? 'claude' : provider)
  const providerFilter = providers?.length
    ? `AND s.provider IN (${providers.map(() => '?').join(', ')})`
    : ''
  const projectFilter = filters.projectRoot ? 'AND s.project_root = ?' : ''
  const roleFilter = filters.role ? 'AND session_messages.role = ?' : ''
  const sinceFilter = filters.sinceTs !== undefined ? 'AND session_messages.ts >= ?' : ''
  const untilFilter = filters.untilTs !== undefined ? 'AND session_messages.ts <= ?' : ''
  const params: Array<string | number> = [ftsQuery]
  if (filters.projectRoot) params.push(filters.projectRoot)
  if (providers?.length) params.push(...providers)
  if (filters.role) params.push(filters.role)
  if (filters.sinceTs !== undefined) params.push(filters.sinceTs)
  if (filters.untilTs !== undefined) params.push(filters.untilTs)
  params.push(limit)

  const rows = getDb().prepare(`
    WITH hits AS MATERIALIZED (
      SELECT
        s.session_id,
        s.provider,
        s.cwd,
        s.project_path,
        s.is_worktree,
        s.slug,
        s.first_message,
        s.last_timestamp,
        s.size,
        s.model,
        s.reasoning_effort,
        s.project_root,
        snippet(session_fts, 0, '', '', '…', 64) AS snippet,
        session_messages.id AS message_id,
        session_messages.ts AS hit_ts,
        bm25(session_fts) AS rank
      FROM session_fts
      JOIN session_messages ON session_messages.id = session_fts.rowid
      JOIN sessions s ON s.session_id = session_messages.session_id
      WHERE session_fts MATCH ?
      ${projectFilter}
      ${providerFilter}
      ${roleFilter}
      ${sinceFilter}
      ${untilFilter}
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

/** Every distinct project (git-root) that has indexed sessions, most-recent
 *  first. `name` is the root's folder name — the label an agent matches against. */
export function listProjectRoots(): Array<{ projectRoot: string; name: string; count: number }> {
  const rows = getDb().prepare(`
    SELECT project_root, COUNT(*) AS count
    FROM sessions
    WHERE project_root IS NOT NULL AND project_root <> ''
    GROUP BY project_root
    ORDER BY MAX(last_timestamp) DESC
  `).all() as Array<{ project_root: string; count: number }>
  return rows.map((row) => ({
    projectRoot: row.project_root,
    name: basename(row.project_root),
    count: row.count,
  }))
}

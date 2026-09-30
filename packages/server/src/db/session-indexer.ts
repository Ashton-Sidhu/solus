import { watch, type FSWatcher } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { z } from 'zod'
import type { SessionLoadMessage, SessionMessageWindow } from '@solus/contracts/session-history'
import type { AgentId, ReasoningEffort, SessionMeta, SessionRecord } from '@solus/contracts/types'
import {
  encodePathAsFolder,
  SOLUS_WORKTREE_ENCODED_MARKER,
  worktreeProjectRoot,
} from '@solus/contracts/types'
import { readSessionHeadMeta } from '../execution/agents/claude/claude-session-helpers'
import { scanPlanFile } from '../execution/agents/claude/claude-plan-helpers'
import {
  markIndexedPlanSessionUnavailable,
  replaceIndexedPlansForSession,
  type IndexedPlanInput,
} from '../plans/plan-index'
import { createLogger } from '../logger'
import { ANY_ORGANIZATION } from '../admission/principal'
import { delegationColumnsFor, type SessionDelegationStart } from '../data/sessions/session-delegations'
import {
  deleteSessionRecord,
  setSessionRecordBranch,
  setSessionRecordTitle,
  upsertOwnSessionRecord,
} from '../data/sessions/session-records'
import { getDb, withTx } from '.'

const log = createLogger('main', 'session-indexer')
const PROJECTS_ROOT = join(homedir(), '.claude', 'projects')
const WATCH_DEBOUNCE_MS = 2_000
const LINES_PER_TRANSACTION = 300
const READ_CHUNK_BYTES = 256 * 1024
export const MAX_INDEXED_SESSION_LINE_BYTES = 4 * 1024 * 1024
const CODEX_SESSION_WATERMARK_KEY = 'codex-session-index-watermark'
const CLAUDE_SWEEP_COMPLETED_KEY = 'claude-session-index-swept-at'
/** Set by the migration that re-reads every message; cleared by the next full sweep. */
const MESSAGES_REBUILD_KEY = 'session-messages-rebuild'
/** A message row id is its session's number times this, plus its position in
 *  the session (docs/plans/unified-search.md §4): a hit names its session with
 *  no join. A session keeps its first 2^20 messages in the index. */
export const SESSION_ROW_SPAN = 2 ** 20

const agentIdSchema = z.enum(['claude-code', 'codex', 'opencode'])
const storedProviderSchema = z.enum(['claude', 'claude-code', 'codex', 'opencode'])
const reasoningEffortSchema = z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode'])
const transcriptContentPartSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
})
const transcriptLineSchema = z.object({
  type: z.enum(['user', 'assistant']),
  message: z.object({
    content: z.union([z.string(), z.array(transcriptContentPartSchema)]),
    role: z.string().optional(),
  }),
  timestamp: z.union([z.string(), z.number()]),
  uuid: z.string().nullable().optional(),
})
export const sessionRowSchema = z.object({
  session_id: z.string(),
  provider: storedProviderSchema,
  cwd: z.string().nullable(),
  project_path: z.string().nullable(),
  is_worktree: z.number().nullable(),
  slug: z.string().nullable(),
  first_message: z.string().nullable(),
  custom_title: z.string().nullable().optional(),
  last_timestamp: z.number().nullable(),
  size: z.number().nullable(),
  model: z.string().nullable(),
  reasoning_effort: reasoningEffortSchema.nullable(),
  project_root: z.string().nullable(),
  server_id: z.string().nullable().optional(),
  branch: z.string().nullable().optional(),
  parent_session_id: z.string().nullable(),
  root_session_id: z.string().nullable(),
  delegation_exchange_id: z.string().nullable(),
  delegation_depth: z.number().nullable(),
  delegation_intent: z.string().nullable(),
  delegation_created_at: z.number().nullable(),
})
const countRowSchema = z.object({ count: z.number() })
const numberRowSchema = z.object({ number: z.number() })
const lastIdRowSchema = z.object({ last: z.number().nullable() })
const offsetRowSchema = z.object({ last_offset: z.number() })
const pathRowSchema = z.object({ path: z.string() })
const storedMessageRowSchema = z.object({
  role: z.string(),
  ts: z.number().nullable(),
  text: z.string(),
})
const valueRowSchema = z.object({ value: z.string() })
const timestampRowSchema = z.object({
  session_id: z.string(),
  last_timestamp: z.number().nullable(),
})
const sessionIdRowSchema = z.object({ session_id: z.string() })
const indexedMessageRowSchema = z.object({
  id: z.number(),
  role: z.enum(['user', 'assistant']),
  ts: z.number().nullable(),
  text: z.string(),
})
const projectRootRowSchema = z.object({ project_root: z.string(), count: z.number() })

type SessionRow = z.infer<typeof sessionRowSchema>

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
let sweptInEarlierRun: boolean | null = null
let generation = 0
let fullSweepPending = false
let sweepQueue: Promise<unknown> = Promise.resolve()
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
  // Plans are durable Workspace artifacts even after Claude's transcript
  // retention removes the source session. Keep the plan, but make resume
  // attempts fail before they create an empty conversation tab.
  markIndexedPlanSessionUnavailable('claude-code', sessionId).catch((error) => {
    log.warn('plan_index_session_unavailable_failed', { sessionId, error: String(error) })
  })
  forgetSessionRecordWithRow(sessionId)
}

/** The record follows the index row: a session the file no longer lists is not in the picker either. */
function forgetSessionRecordWithRow(sessionId: string): void {
  const row = getDb().prepare('SELECT 1 AS present FROM sessions WHERE session_id = ?').get(sessionId)
  if (row) return
  deleteSessionRecord(ANY_ORGANIZATION, sessionId).catch((error) => {
    log.warn('session_record_delete_failed', { sessionId, error: String(error) })
  })
}

/** Clear a file's message index so it re-reads from offset 0. The sessions row
 *  is deliberately left alone: re-indexing upserts over it, and deleting it here
 *  would race the model-config write from session_init that promptSession needs
 *  to re-launch a non-resident session. De-listing a session is a separate
 *  concern owned by deleteSessionFile and the sidechain branch of indexFile. */
export function resetSession(filePath: string, sessionId: string): void {
  withTx(() => {
    const db = getDb()
    db.prepare('DELETE FROM session_fts WHERE rowid IN (SELECT id FROM session_messages WHERE session_id = ?)').run(sessionId)
    db.prepare('DELETE FROM session_messages WHERE session_id = ?').run(sessionId)
    db.prepare(`
      INSERT INTO session_files(path, provider, last_offset)
      VALUES (?, 'claude', 0)
      ON CONFLICT(path) DO UPDATE SET
        provider = excluded.provider,
        last_offset = 0
    `).run(filePath)
  })
}

function extractMessage(line: string, endOffset: number): IndexedMessage | null {
  try {
    const parsed = transcriptLineSchema.safeParse(JSON.parse(line))
    if (!parsed.success) return null
    const obj = parsed.data

    const content = obj.message.content
    const text = Array.isArray(content)
      ? content
        .filter((item) => item.type === 'text')
        .map((item) => item.text ?? '')
        .join('\n')
      : content
    if (!text.trim()) return null

    const parsedTs = new Date(obj.timestamp).getTime()
    return {
      endOffset,
      uuid: obj.uuid ?? null,
      role: obj.message.role ?? obj.type,
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

/** The number a session's message row ids are built on, given on first use. */
function sessionNumber(sessionId: string): number {
  const db = getDb()
  db.prepare('INSERT INTO session_keys(session_id) VALUES (?) ON CONFLICT(session_id) DO NOTHING').run(sessionId)
  return numberRowSchema.parse(db.prepare('SELECT number FROM session_keys WHERE session_id = ?').get(sessionId)).number
}

function insertSessionMessageRows(
  sessionId: string,
  messages: Iterable<StoredMessage | null>,
): void {
  const db = getDb()
  const first = sessionNumber(sessionId) * SESSION_ROW_SPAN
  const end = first + SESSION_ROW_SPAN
  // Appended after the session's last row: a tail read continues the positions.
  const last = lastIdRowSchema.parse(db.prepare('SELECT MAX(id) AS last FROM session_messages WHERE id >= ? AND id < ?').get(first, end)).last
  let id = last === null ? first : last + 1
  const insertMessage = db.prepare(`
    INSERT INTO session_messages(id, session_id, uuid, role, ts, text)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  const insertFts = db.prepare('INSERT INTO session_fts(rowid, text) VALUES (?, ?)')
  for (const message of messages) {
    if (!message) continue
    if (id >= end) {
      log.warn('session_index_span_full', { sessionId })
      return
    }
    insertMessage.run(id, sessionId, message.uuid, message.role, message.ts, message.text)
    insertFts.run(id, message.text)
    id += 1
  }
}

export function indexSessionMessages(
  sessionId: string,
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
    insertSessionMessageRows(sessionId, storedMessages)
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
  getDb().prepare(`
    INSERT INTO sessions(
      session_id, provider, cwd, project_path, project_root, is_worktree,
      slug, first_message, last_timestamp, size
    )
    VALUES (?, 'claude', ?, ?, ?, ?, ?, ?, ?, ?)
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
  `).run(
    sessionId,
    cwd,
    projectPath,
    projectRootFor(cwd),
    isWorktree ? 1 : 0,
    slug,
    firstMessage,
    lastTimestamp,
    size,
  )
}

/** The collaboration plane's record of a session, fed by the same sweep that indexed its file. */
function recordIndexedClaudeSession(
  sessionId: string,
  projectPath: string,
  isWorktree: boolean,
  meta: { cwd: string | null; slug: string | null; firstMessage: string | null },
  mtime: number,
  size: number,
): Promise<SessionRecord> {
  return upsertOwnSessionRecord({
    sessionId,
    provider: 'claude-code',
    projectPath,
    title: meta.firstMessage ?? meta.slug ?? undefined,
    lastActivityAt: mtime,
    size,
    cwd: meta.cwd ?? undefined,
    slug: meta.slug ?? undefined,
    isWorktree,
    projectRoot: projectRootFor(meta.cwd) ?? undefined,
  })
}

/** Resolves true when the file needed work, so a sweep can report how much of
 *  the store it actually had to read. */
async function indexFile(filePath: string, activeGeneration: number): Promise<boolean> {
  let fileStat
  try {
    fileStat = await stat(filePath)
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      if (activeGeneration !== generation) return false
      deleteSessionFile(filePath)
      return true
    }
    throw error
  }
  if (activeGeneration !== generation || !fileStat.isFile()) return false

  const db = getDb()
  const tracked = offsetRowSchema.nullish().parse(
    db.prepare('SELECT last_offset FROM session_files WHERE path = ?').get(filePath),
  )
  const lastOffset = tracked?.last_offset ?? 0
  if (fileStat.size === lastOffset) return false

  const sessionId = basename(filePath, '.jsonl')
  const mtime = Math.trunc(fileStat.mtimeMs)
  if (fileStat.size < 100) {
    resetSession(filePath, sessionId)
    return true
  }
  if (!tracked || fileStat.size < lastOffset) {
    resetSession(filePath, sessionId)
  }
  const readOffset = !tracked || fileStat.size < lastOffset ? 0 : lastOffset
  const meta = await readSessionHeadMeta(filePath)
  if (activeGeneration !== generation) return false
  if (!meta.validated || meta.isSidechain) {
    resetSession(filePath, sessionId)
    // De-list sidechain/unparseable files — but a session file mid-write can
    // transiently fail head validation, so (like deleteSessionFile) never drop
    // a row carrying the model config persisted at session_init.
    getDb().prepare(`
      DELETE FROM sessions
      WHERE session_id = ? AND model IS NULL AND reasoning_effort IS NULL
    `).run(sessionId)
    getDb().prepare('UPDATE session_files SET last_offset = ? WHERE path = ?').run(fileStat.size, filePath)
    forgetSessionRecordWithRow(sessionId)
    return true
  }

  const projectPath = relative(PROJECTS_ROOT, filePath).split(/[\\/]/)[0] || basename(dirname(filePath))
  const isWorktree = projectPath.includes(SOLUS_WORKTREE_ENCODED_MARKER)
  let lastIndexedOffset = readOffset

  for await (const records of readTailRecordBatches(filePath, readOffset, fileStat.size)) {
    if (activeGeneration !== generation) return false
    lastIndexedOffset = records.at(-1)!.endOffset
    withTx(() => {
      const openedDb = getDb()
      insertSessionMessageRows(sessionId, records.map((record) => record.message))
      openedDb.prepare('UPDATE session_files SET last_offset = ? WHERE path = ?').run(lastIndexedOffset, filePath)
    })
    await yieldToMain()
  }
  if (activeGeneration !== generation) return false

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
    getDb().prepare('UPDATE session_files SET last_offset = ? WHERE path = ?').run(lastIndexedOffset, filePath)
  })
  await recordIndexedClaudeSession(sessionId, projectPath, isWorktree, meta, mtime, fileStat.size)
  const scannedPlans = await scanPlanFile(filePath, sessionId, projectPath, meta.cwd ?? projectPath)
  const indexedPlans: IndexedPlanInput[] = scannedPlans.map((plan) => ({
    provider: 'claude-code',
    sessionId: plan.sessionId,
    planToolUseId: plan.planToolUseId,
    projectPath: plan.projectPath,
    cwd: plan.cwd,
    timestamp: plan.timestamp,
    title: plan.title,
    excerpt: plan.excerpt,
    planFilePath: plan.planFilePath,
    content: plan.content,
    derivedStatus: plan.derivedStatus,
  }))
  await replaceIndexedPlansForSession('claude-code', sessionId, indexedPlans)
  return true
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

interface SweepResult {
  /** Transcripts the store holds. */
  files: number
  /** Of those, the ones that had changed and had to be read. */
  indexed: number
}

async function sweepAll(activeGeneration: number): Promise<SweepResult> {
  const files = await listTranscriptFiles(activeGeneration)
  const result: SweepResult = { files: files.length, indexed: 0 }
  if (activeGeneration !== generation) return result
  const seen = new Set(files)
  for (const filePath of files) {
    try {
      if (await indexFile(filePath, activeGeneration)) result.indexed++
    } catch (error) {
      log.warn('session_index_file_failed', { filePath, error: error instanceof Error ? error.message : String(error) })
    }
    await yieldToMain()
  }
  if (activeGeneration !== generation) return result

  const tracked = pathRowSchema.array().parse(
    getDb().prepare("SELECT path FROM session_files WHERE provider = 'claude'").all(),
  )
  for (const { path } of tracked) {
    if (!seen.has(path)) deleteSessionFile(path)
  }
  return result
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
          (promise, filePath) => promise.then(async () => { await indexFile(filePath, activeGeneration) }),
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
  const startedAt = Date.now()
  log.info('session_index_sweep_started', { servingListsFromIndex: sweptInAnEarlierRun() })
  void sweepAll(activeGeneration)
    .then(({ files, indexed }) => {
      if (activeGeneration !== generation) return
      markSweepCompleted()
      log.info('session_index_sweep_completed', { durationMs: Date.now() - startedAt, files, indexed })
    })
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
  sweptInEarlierRun = null
  watcher?.close()
  watcher = null
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = null
  changedPaths.clear()
  fullSweepPending = false
}

/** Whether some earlier run of this app finished a sweep of the whole store.
 *  Cached after the first read: every session list asks, and it changes at most
 *  once in a process. */
function sweptInAnEarlierRun(): boolean {
  if (sweptInEarlierRun === null) {
    sweptInEarlierRun = Boolean(getDb().prepare('SELECT 1 FROM kv WHERE key = ?').get(CLAUDE_SWEEP_COMPLETED_KEY))
  }
  return sweptInEarlierRun
}

function markSweepCompleted(): void {
  getDb().prepare(`
    INSERT INTO kv(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(CLAUDE_SWEEP_COMPLETED_KEY, String(Date.now()))
  getDb().prepare('DELETE FROM kv WHERE key = ?').run(MESSAGES_REBUILD_KEY)
  sweptInEarlierRun = true
}

/** True while the messages are read again after the index changed shape: a
 *  search answers from part of them, and says so. */
export function sessionMessagesRebuilding(): boolean {
  return Boolean(getDb().prepare('SELECT 1 FROM kv WHERE key = ?').get(MESSAGES_REBUILD_KEY))
}

/**
 * Whether a session list can be answered from the index instead of reading
 * every transcript off disk.
 *
 * True once this run's sweep finishes — and from the first moment of every run
 * after the first, because an earlier sweep already indexed the whole store and
 * this run's sweep only catches up on what changed while the app was closed.
 * Waiting for the sweep instead made each launch open its first picker against
 * the filesystem: for one busy project that is a head-read of ~600 transcripts.
 *
 * Before any sweep has ever completed the index is still filling, so a list
 * read would return a project that looks complete and is not.
 */
export function sessionIndexComplete(): boolean {
  return ready || sweptInAnEarlierRun()
}

export function rowToSession(row: SessionRow): SessionMeta {
  const provider = agentIdSchema.parse(row.provider === 'claude' ? 'claude-code' : row.provider)
  const delegation = row.parent_session_id
    && row.root_session_id
    && row.delegation_exchange_id
    && row.delegation_depth !== null
    && (row.delegation_intent === 'delegate' || row.delegation_intent === 'fire_and_forget')
    && row.delegation_created_at !== null
    ? {
        parentSessionId: row.parent_session_id,
        rootSessionId: row.root_session_id,
        messageId: row.delegation_exchange_id,
        depth: row.delegation_depth,
        intent: row.delegation_intent,
        createdAt: row.delegation_created_at,
      }
    : undefined
  return {
    provider,
    sessionId: row.session_id,
    slug: row.slug,
    firstMessage: row.first_message,
    customTitle: row.custom_title ?? undefined,
    lastTimestamp: new Date(row.last_timestamp ?? 0).toISOString(),
    size: row.size ?? 0,
    cwd: row.cwd ?? '',
    projectPath: row.project_path ?? '',
    isWorktree: row.is_worktree === 1,
    model: row.model ?? undefined,
    reasoningEffort: row.reasoning_effort ?? undefined,
    projectRoot: row.project_root ?? undefined,
    serverId: row.server_id ?? undefined,
    branch: row.branch ?? undefined,
    delegation,
  }
}

const SESSION_SELECT = `
  session_id, provider, cwd, project_path, is_worktree, slug, first_message,
  custom_title, last_timestamp, size, model, reasoning_effort, project_root,
  server_id, branch, parent_session_id, root_session_id, delegation_exchange_id,
  delegation_depth, delegation_intent, delegation_created_at
`

export function getIndexedSession(sessionId: string): SessionMeta | null {
  const row = sessionRowSchema.nullish().parse(
    getDb().prepare(`SELECT ${SESSION_SELECT} FROM sessions WHERE session_id = ?`).get(sessionId),
  )
  return row ? rowToSession(row) : null
}

/** The sessions these sessions started, by provider thread. */
export function getChildSessions(parentSessionIds: readonly string[]): SessionMeta[] {
  if (!parentSessionIds.length) return []
  const placeholders = parentSessionIds.map(() => '?').join(', ')
  return sessionRowSchema.array().parse(
    getDb().prepare(`SELECT ${SESSION_SELECT} FROM sessions WHERE parent_session_id IN (${placeholders}) ORDER BY last_timestamp DESC`).all(...parentSessionIds),
  ).map(rowToSession)
}

export function getSessionMessages(sessionId: string): Array<{ role: string; ts: number | null; text: string }> {
  return storedMessageRowSchema.array().parse(getDb().prepare(`
    SELECT role, ts, text
    FROM session_messages
    WHERE session_id = ?
    ORDER BY id ASC
  `).all(sessionId))
}

/** The six delegation columns of a `sessions` row, in insert order; all null
 *  for a session nobody delegated. */
function delegationRowValues(delegation: SessionDelegationStart | undefined): [string | null, string | null, string | null, number | null, string | null, number | null] {
  if (!delegation) return [null, null, null, null, null, null]
  const columns = delegationColumnsFor(delegation)
  return [columns.parentSessionId, columns.rootSessionId, columns.messageId, columns.depth, columns.intent, columns.createdAt]
}

export function persistIndexedSessionStart(
  sessionId: string,
  provider: AgentId,
  cwd: string,
  projectPath: string,
  model: string,
  reasoningEffort: ReasoningEffort,
  firstMessage: string | null = null,
  branch: string | null = null,
  delegation?: SessionDelegationStart,
): void {
  const parent = delegationRowValues(delegation)
  getDb().prepare(`
    INSERT INTO sessions(
      session_id, provider, cwd, project_path, project_root, is_worktree,
      slug, first_message, last_timestamp, size, model, reasoning_effort, branch,
      parent_session_id, root_session_id, delegation_exchange_id, delegation_depth,
      delegation_intent, delegation_created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      project_root = COALESCE(sessions.project_root, excluded.project_root),
      first_message = COALESCE(sessions.first_message, excluded.first_message),
      model = COALESCE(sessions.model, excluded.model),
      reasoning_effort = COALESCE(sessions.reasoning_effort, excluded.reasoning_effort),
      branch = COALESCE(sessions.branch, excluded.branch),
      parent_session_id = COALESCE(sessions.parent_session_id, excluded.parent_session_id),
      root_session_id = COALESCE(sessions.root_session_id, excluded.root_session_id),
      delegation_exchange_id = COALESCE(sessions.delegation_exchange_id, excluded.delegation_exchange_id),
      delegation_depth = COALESCE(sessions.delegation_depth, excluded.delegation_depth),
      delegation_intent = COALESCE(sessions.delegation_intent, excluded.delegation_intent),
      delegation_created_at = COALESCE(sessions.delegation_created_at, excluded.delegation_created_at)
  `).run(
    sessionId,
    provider === 'claude-code' ? 'claude' : provider,
    cwd,
    projectPath,
    projectRootFor(cwd),
    projectPath.includes(SOLUS_WORKTREE_ENCODED_MARKER) ? 1 : 0,
    firstMessage,
    Date.now(),
    model,
    reasoningEffort,
    branch,
    ...parent,
  )
  const [parentSessionId, rootSessionId, messageId, depth, intent, createdAt] = parent
  void upsertOwnSessionRecord({
    sessionId,
    provider,
    projectPath,
    title: firstMessage ?? undefined,
    model,
    reasoningEffort,
    status: 'running',
    lastActivityAt: Date.now(),
    parentSessionId: parentSessionId ?? undefined,
    rootSessionId: rootSessionId ?? undefined,
    cwd,
    isWorktree: projectPath.includes(SOLUS_WORKTREE_ENCODED_MARKER),
    branch: branch ?? undefined,
    projectRoot: projectRootFor(cwd) ?? undefined,
    delegation: messageId !== null && depth !== null && createdAt !== null && (intent === 'delegate' || intent === 'fire_and_forget')
      ? { messageId, depth, intent, createdAt }
      : undefined,
  }).catch((error) => {
    log.warn('session_record_start_failed', { sessionId, error: String(error) })
  })
}

/**
 * Record a session this host knows about but does not hold: one a client
 * dispatched to another machine while its task stayed here (ADR-0006).
 *
 * The client is the only party that can write this — the execution host cannot
 * name itself, and this host never sees the session's transcript. `cwd` and
 * `project_path` stay null on purpose: the agent's checkout is a path on the
 * borrowed machine and would file the session under a project that does not
 * exist here. `projectRoot` is the group path as the *user* knows it, which is
 * the one location fact that means the same thing on both machines.
 *
 * Existing columns are never overwritten, so a host that later indexes the real
 * transcript wins on everything except the one fact only the client had.
 */
export function persistRemoteSessionStart(
  sessionId: string,
  provider: AgentId,
  serverId: string,
  projectRoot: string | null,
): void {
  getDb().prepare(`
    INSERT INTO sessions(
      session_id, provider, cwd, project_path, project_root,
      is_worktree, slug, first_message, last_timestamp, size, server_id
    )
    VALUES (?, ?, NULL, NULL, ?, 0, NULL, NULL, ?, 0, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      project_root = COALESCE(sessions.project_root, excluded.project_root),
      server_id = COALESCE(excluded.server_id, sessions.server_id)
  `).run(
    sessionId,
    provider === 'claude-code' ? 'claude' : provider,
    projectRoot,
    Date.now(),
    serverId,
  )
  void upsertOwnSessionRecord({
    sessionId,
    provider,
    projectPath: projectRoot ? encodePathAsFolder(projectRoot) : '',
    runnerHostId: serverId,
    lastActivityAt: Date.now(),
    projectRoot: projectRoot ?? undefined,
  }).catch((error) => {
    log.warn('session_record_remote_start_failed', { sessionId, error: String(error) })
  })
}

/** Record the checkout owned by one session attempt. The row is created by
 * session initialization (or by `persistRemoteSessionStart` on a task host),
 * so metadata never creates a session or any task relationship. */
export function setSessionBranch(sessionId: string, branch: string): void {
  getDb().prepare(`
    UPDATE sessions
    SET branch = ?
    WHERE session_id = COALESCE((
      SELECT provider_session_id
      FROM session_lineage_members
      WHERE session_id = ?
      ORDER BY position DESC
      LIMIT 1
    ), ?)
  `).run(branch, sessionId, sessionId)
  void setSessionRecordBranch(sessionId, branch).catch((error) => {
    log.warn('session_record_branch_failed', { sessionId, error: String(error) })
  })
}

/** Name a session, or clear the name back to the derived one with null. Only
 *  ever an UPDATE: every session that can be renamed is already a row (live
 *  sessions land one at session_init, history sessions come from the index). */
export async function setSessionCustomTitle(sessionId: string, title: string | null): Promise<void> {
  getDb().prepare('UPDATE sessions SET custom_title = ? WHERE session_id = ?').run(title, sessionId)
  await setSessionRecordTitle(ANY_ORGANIZATION, sessionId, title)
}

export async function cacheIndexedSessions(sessions: SessionMeta[]): Promise<void> {
  if (sessions.length === 0) return
  withTx(() => {
    const upsert = getDb().prepare(`
      INSERT INTO sessions(
        session_id, provider, cwd, project_path, project_root, is_worktree,
        slug, first_message, last_timestamp, size, branch
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        provider = excluded.provider,
        cwd = excluded.cwd,
        project_path = excluded.project_path,
        project_root = excluded.project_root,
        is_worktree = excluded.is_worktree,
        slug = excluded.slug,
        first_message = excluded.first_message,
        last_timestamp = excluded.last_timestamp,
        size = excluded.size,
        branch = COALESCE(excluded.branch, sessions.branch)
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
        session.branch ?? null,
      )
    }
  })
  for (const session of sessions) {
    await upsertOwnSessionRecord({
      sessionId: session.sessionId,
      provider: session.provider,
      projectPath: session.projectPath,
      title: session.firstMessage ?? session.slug ?? undefined,
      lastActivityAt: new Date(session.lastTimestamp).getTime(),
      size: session.size,
      cwd: session.cwd || undefined,
      slug: session.slug ?? undefined,
      isWorktree: session.isWorktree ?? false,
      branch: session.branch,
      projectRoot: projectRootFor(session.cwd) ?? undefined,
    })
  }
}

export function getCodexSessionIndexWatermark(): number | null {
  const row = valueRowSchema.nullish().parse(
    getDb().prepare('SELECT value FROM kv WHERE key = ?').get(CODEX_SESSION_WATERMARK_KEY),
  )
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
    const rows = timestampRowSchema.array().parse(getDb().prepare(`
      SELECT session_id, last_timestamp
      FROM sessions
      WHERE provider = 'codex' AND session_id IN (${placeholders})
    `).all(...batch))
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
    const rows = sessionIdRowSchema.array().parse(getDb().prepare(`
      SELECT DISTINCT session_id
      FROM session_messages
      WHERE session_id IN (${placeholders})
    `).all(...batch))
    for (const row of rows) withMessages.add(row.session_id)
  }
  return withMessages
}

const MAX_WINDOW_RADIUS = 5

/**
 * The messages around one message of a session, for a preview that opens on
 * a search hit instead of on the transcript's ends.
 *
 * Rows are written in transcript order — a re-index replaces every row of the
 * session in one pass and a tail read appends — so the row id is the position
 * and the neighbours are the ids either side. Empty when the id is gone: the
 * session was re-indexed after the search that named it.
 */
export function getSessionMessageWindow(
  sessionId: string,
  messageId: number,
  radius = 1,
): SessionMessageWindow {
  const db = getDb()
  const span = Math.min(MAX_WINDOW_RADIUS, Math.max(0, Math.trunc(radius)))
  const hit = indexedMessageRowSchema.nullish().parse(db.prepare(`
    SELECT id, role, ts, text FROM session_messages WHERE session_id = ? AND id = ?
  `).get(sessionId, messageId))
  if (!hit) return { messages: [], hiddenBefore: 0, hiddenAfter: 0 }
  const before = indexedMessageRowSchema.array().parse(db.prepare(`
    SELECT id, role, ts, text FROM session_messages
    WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?
  `).all(sessionId, messageId, span)).reverse()
  const after = indexedMessageRowSchema.array().parse(db.prepare(`
    SELECT id, role, ts, text FROM session_messages
    WHERE session_id = ? AND id > ? ORDER BY id ASC LIMIT ?
  `).all(sessionId, messageId, span))
  const countBefore = countRowSchema.parse(db.prepare(`
    SELECT COUNT(*) AS count FROM session_messages WHERE session_id = ? AND id < ?
  `).get(sessionId, messageId)).count
  const countAfter = countRowSchema.parse(db.prepare(`
    SELECT COUNT(*) AS count FROM session_messages WHERE session_id = ? AND id > ?
  `).get(sessionId, messageId)).count
  return {
    messages: [...before, hit, ...after].map((row) => ({
      messageId: row.id,
      role: row.role,
      ts: row.ts,
      text: row.text,
    })),
    hiddenBefore: countBefore - before.length,
    hiddenAfter: countAfter - after.length,
  }
}

/** Every distinct project (git-root) that has indexed sessions, most-recent
 *  first. `name` is the root's folder name — the label an agent matches against. */
export function listProjectRoots(): Array<{ projectRoot: string; name: string; count: number }> {
  const rows = projectRootRowSchema.array().parse(getDb().prepare(`
    SELECT project_root, COUNT(*) AS count
    FROM sessions
    WHERE project_root IS NOT NULL AND project_root <> ''
    GROUP BY project_root
    ORDER BY MAX(last_timestamp) DESC
  `).all())
  return rows.map((row) => ({
    projectRoot: row.project_root,
    name: basename(row.project_root),
    count: row.count,
  }))
}

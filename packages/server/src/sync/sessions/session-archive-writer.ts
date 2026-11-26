import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import type { AgentId, PermissionMode, ReasoningEffort, SessionLineageMember, TurnSnapshot } from '@solus/contracts/types'
import { sessionStarterSchema } from '@solus/contracts/session-starter'
import { ANY_ORGANIZATION } from '../../admission/principal'
import { resolveSessionLineageById } from '../../data/sessions/session-lineage'
import { getSessionRecord } from '../../data/sessions/session-records'
import { readSessionStorage } from '../../data/sessions/session-storage'
import { getDb, withTx } from '../../db'
import { runAsync } from '../../git/exec'
import { resolveRepoRoot, resolveRepositoryKey } from '../../git/git-helpers'
import { writeTurnCodeBundle, type TurnCodeBundle } from '../../git/session-code-bundle'
import { getSessionBaseSha, getSessionPaths, listTurnSnapshots } from '../../git/session-snapshots'
import { createLogger } from '../../logger'
import { resolveHomePath } from '../../platform/paths'
import { captureActingScope, withActingScope, withUserScope } from '../../vault/acting-scope'
import { emptySessionManifest, THREAD_PIECE_BYTES, type SessionManifest, type SessionManifestThreadFile, type SessionManifestTurn } from './session-manifest'
import type { GitFileEntry } from '../git-storage/git-repository'
import { SessionHeadMovedError, sessionRepositoryName, type SessionRepositories, type SessionRepository, type TurnCommit } from './session-repository'
import type { EndedTurn } from '../mirror/turn-diff-mirror'

const log = createLogger('SessionArchive', 'session-archive-writer.ts')

/**
 * Writes each ended turn to the local session repository
 * (docs/plans/portable-sessions.md §7.2). The repository is for a host that
 * continues the session: a turn commit holds the provider thread files and the
 * code state. It holds no rows and no patch; a reader gets those from the
 * transcript mirror (`sync/mirror/`).
 *
 * `turnEnded` records the turn in a durable row and answers; the turn commit is
 * built after that, one at a time on this host, so nothing in a turn waits for
 * Git. The row holds the length of each provider file when the turn ended: a
 * commit that is built while the next turn already runs still ends at the turn
 * boundary.
 *
 * The format fits Cloudflare Artifacts (docs/plans/session-storage.md §4): a
 * provider file range goes in pieces of at most `THREAD_PIECE_BYTES`, a commit
 * adds at most `COMMIT_BYTES` of new files, and the code bundle of a turn is
 * under its own ref, not in `main`. A turn with more new bytes is several
 * commits; only the last writes the manifest of the turn.
 */

/** One provider file of a thread, as its adapter names it. */
export interface ThreadFile {
  /** A name for the file inside the session repository: plain characters, no separator. */
  key: string
  /** Where the file is under the provider's own folder for the thread. */
  relativePath: string
  /** Where the file is on this host. */
  path: string
}

export interface TurnEnd {
  sessionId: string
  organizationId: string
  provider: AgentId
  threadId: string
  /** The folder the provider keeps the thread under, when it files threads by project. */
  projectPath?: string
  /** The session's checkout on this host; absent for a session with no folder. */
  workTree?: string
  partial: boolean
  /** Wall time at turn settlement, before asynchronous capture can run. */
  endedAt?: number
  model?: string
  reasoningEffort?: ReasoningEffort
  permissionMode?: PermissionMode
}

const pendingTurnSchema = z.object({
  organizationId: z.string(),
  provider: z.string(),
  threadId: z.string(),
  partial: z.boolean(),
  endedAt: z.number(),
  model: z.string().optional(),
  reasoningEffort: z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode']).optional(),
  permissionMode: z.enum(['supervised', 'accept-edits', 'auto', 'full-access', 'plan']).optional(),
  title: z.string().nullable().optional(),
  startedBy: sessionStarterSchema.nullable().optional(),
  parentSessionId: z.string().nullable().optional(),
  rootSessionId: z.string().nullable().optional(),
  lineage: z.array(z.object({ threadId: z.string(), provider: z.string(), startedAs: z.enum(['start', 'fork', 'handoff']) })).optional(),
  sessionPaths: z.object({ turnPaths: z.array(z.string()), sessionChangedFiles: z.array(z.string()) }).nullable().optional(),
  lastProjectRoot: z.string().nullable().optional(),
  files: z.array(z.object({ key: z.string(), relativePath: z.string(), path: z.string(), length: z.number() })),
  /** The checkout facts when the turn ended; null for a session with no repository. */
  checkout: z.object({
    workTree: z.string(),
    repoRoot: z.string(),
    snapshotCount: z.number(),
    headSha: z.string().nullable(),
    branch: z.string().nullable(),
  }).nullable(),
})
type PendingTurn = z.infer<typeof pendingTurnSchema>

const pendingRowSchema = z.object({ operation_id: z.string(), facts: z.string() })
const sessionIdRowSchema = z.object({ session_id: z.string() })

export interface SessionArchiveDeps {
  repositories: SessionRepositories
  /** The provider files of a thread on this host; empty for a provider that keeps none. */
  threadFiles(provider: AgentId, threadId: string, projectPath: string | undefined): Promise<ThreadFile[]>
  database?: () => DatabaseSync
  now?: () => number
  /** The wait before a failed turn commit is tried again; it doubles up to `MAX_RETRY_MS`. */
  retryMs?: number
  onCommit?: (sessionId: string) => void
  /** Gives the diff of a committed turn to the mirror (`mirror/turn-diff-mirror.ts`), where a reader with no host online reads it. */
  turnDiff?: (turn: EndedTurn) => Promise<void>
}

const MAX_RETRY_MS = 30 * 60_000
/** The most new file bytes in one commit. Artifacts refuses a push above 64 MiB. */
const COMMIT_BYTES = 48 * 1024 * 1024

export class SessionArchiveWriter {
  private readonly database: () => DatabaseSync
  private readonly now: () => number
  /** One Git job at a time on a host. */
  private queue: Promise<void> = Promise.resolve()
  private readonly sessionJobs = new Map<string, Promise<void>>()
  private readonly sessionCommits = new Map<string, Promise<void>>()
  private readonly captureErrors = new Set<string>()
  private readonly retries = new Map<string, { timer: ReturnType<typeof setTimeout>; waitMs: number }>()
  private stopped = false

  constructor(private readonly deps: SessionArchiveDeps) {
    this.database = deps.database ?? getDb
    this.now = deps.now ?? Date.now
  }

  /** Record that a turn ended. The turn commit is written in the background. Never rejects: the turn is over. */
  async turnEnded(turn: TurnEnd): Promise<void> {
    turn = { ...turn, endedAt: turn.endedAt ?? this.now() }
    const previous = this.sessionJobs.get(turn.sessionId)
    const work = (async () => {
      if (previous) await previous
      try {
        await (captureActingScope() ? this.record(turn) : withUserScope(null, () => this.record(turn)))
        this.captureErrors.delete(turn.sessionId)
      } catch (error) {
        this.captureErrors.add(turn.sessionId)
        log.warn('session_turn_record_failed', { sessionId: turn.sessionId, error: error instanceof Error ? error.message : String(error) })
      }
    })()
    this.sessionJobs.set(turn.sessionId, work)
    await work
    if (this.sessionJobs.get(turn.sessionId) === work) this.sessionJobs.delete(turn.sessionId)
  }

  private async record(turn: TurnEnd): Promise<void> {
    const pending = await this.capture(turn)
    if (!pending.files.length && !pending.checkout) return
    withTx(() => {
      const db = this.database()
      db.prepare('INSERT INTO session_storage (session_id, repository) VALUES (?, ?) ON CONFLICT(session_id) DO NOTHING')
        .run(turn.sessionId, sessionRepositoryName(turn.organizationId, turn.sessionId))
      db.prepare('INSERT INTO session_storage_turns (operation_id, session_id, created_at, facts) VALUES (?, ?, ?, ?)')
        .run(randomUUID(), turn.sessionId, pending.endedAt, JSON.stringify(pending))
    })
    this.schedule(turn.sessionId)
  }

  /** After a restart: write the turns that ended before it and have no commit. */
  resume(): void {
    const rows = sessionIdRowSchema.array().parse(this.database().prepare('SELECT DISTINCT session_id FROM session_storage_turns').all())
    for (const row of rows) this.schedule(row.session_id)
  }

  /** Settles when no turn commit is in progress. */
  async idle(): Promise<void> {
    await this.queue
  }

  /** Wait for this session's capture and commit. False means its pending turn failed or timed out. */
  async waitForSession(sessionId: string, timeoutMs: number): Promise<boolean> {
    const wait = async (): Promise<boolean> => {
      for (;;) {
        const capture = this.sessionJobs.get(sessionId)
        if (capture) await capture
        const commit = this.sessionCommits.get(sessionId)
        if (commit) await commit
        if (capture !== this.sessionJobs.get(sessionId) || commit !== this.sessionCommits.get(sessionId)) continue
        // SAFETY: the query selects only the nullable error column.
        const row = this.database().prepare('SELECT error FROM session_storage WHERE session_id = ?').get(sessionId) as { error: string | null } | undefined
        return !row?.error && !this.captureErrors.has(sessionId)
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([wait(), new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); timer.unref() })])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const retry of this.retries.values()) clearTimeout(retry.timer)
    this.retries.clear()
    await this.queue
  }

  private async capture(turn: TurnEnd): Promise<PendingTurn> {
    const endedAt = turn.endedAt ?? this.now()
    const record = await getSessionRecord(ANY_ORGANIZATION, turn.sessionId).catch(() => null)
    const files: PendingTurn['files'] = []
    for (const file of await this.deps.threadFiles(turn.provider, turn.threadId, turn.projectPath).catch(() => [])) {
      // A file that cannot be read (it is gone, or it is another user's) is left out.
      const length = await stat(file.path).then((stats) => stats.size, () => null)
      if (length !== null) files.push({ ...file, length })
    }
    const checkout = await this.checkoutOf(turn).catch(() => null)
    return {
      organizationId: turn.organizationId, provider: turn.provider, threadId: turn.threadId, partial: turn.partial, endedAt, files,
      title: record?.customTitle ?? record?.title ?? null,
      model: turn.model, reasoningEffort: turn.reasoningEffort, permissionMode: turn.permissionMode,
      startedBy: record?.startedBy ?? null, parentSessionId: record?.parentSessionId ?? null, rootSessionId: record?.rootSessionId ?? null,
      lineage: manifestLineage(resolveSessionLineageById(turn.sessionId, this.database())?.members ?? [], turn, !!record?.parentSessionId),
      lastProjectRoot: turn.projectPath ?? null,
      // A folder that cannot be read as a checkout still leaves the thread of the turn to write.
      checkout,
      sessionPaths: checkout ? await getSessionPaths(checkout.repoRoot, turn.sessionId) : null,
    }
  }

  private async checkoutOf(turn: TurnEnd): Promise<PendingTurn['checkout']> {
    if (!turn.workTree) return null
    const workTree = resolve(resolveHomePath(turn.workTree))
    const repoRoot = await resolveRepoRoot(workTree)
    // A session with no snapshot base has no code state to carry.
    if (!repoRoot || !getSessionBaseSha(repoRoot, turn.sessionId)) return null
    const [snapshots, headSha, branch] = await Promise.all([
      listTurnSnapshots(repoRoot, turn.sessionId),
      runAsync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], workTree).catch(() => null),
      runAsync('git', ['symbolic-ref', '--short', '-q', 'HEAD'], workTree).catch(() => null),
    ])
    return { workTree, repoRoot, snapshotCount: snapshots.length, headSha: headSha || null, branch: branch || null }
  }

  private schedule(sessionId: string): void {
    if (this.stopped) return
    // The job starts processes in the project; they act as whoever ran the turn, or as the host after a restart.
    const scope = captureActingScope()
    const job = () => scope ? withActingScope(scope, () => this.writePending(sessionId)) : withUserScope(null, () => this.writePending(sessionId))
    this.queue = this.queue.then(job).then(
      () => { this.clearRetry(sessionId) },
      (error) => { this.failed(sessionId, error instanceof Error ? error.message : String(error)) },
    )
    const scheduled = this.queue
    this.sessionCommits.set(sessionId, scheduled)
    void scheduled.then(() => { if (this.sessionCommits.get(sessionId) === scheduled) this.sessionCommits.delete(sessionId) })
  }

  private failed(sessionId: string, reason: string): void {
    log.warn('session_turn_commit_failed', { sessionId, error: reason })
    this.database().prepare('UPDATE session_storage SET error = ? WHERE session_id = ?')
      .run('The turn could not be written to the session repository; Solus will try again.', sessionId)
    if (this.stopped) return
    const waitMs = Math.min(MAX_RETRY_MS, (this.retries.get(sessionId)?.waitMs ?? (this.deps.retryMs ?? 30_000) / 2) * 2)
    this.clearRetry(sessionId)
    const timer = setTimeout(() => { this.schedule(sessionId) }, waitMs)
    timer.unref()
    this.retries.set(sessionId, { timer, waitMs })
  }

  private clearRetry(sessionId: string): void {
    const retry = this.retries.get(sessionId)
    if (retry) clearTimeout(retry.timer)
    this.retries.delete(sessionId)
  }

  private async writePending(sessionId: string): Promise<void> {
    const db = this.database()
    for (;;) {
      const storage = readSessionStorage(sessionId, db)
      const row = pendingRowSchema.nullish().parse(db.prepare(
        'SELECT operation_id, facts FROM session_storage_turns WHERE session_id = ? ORDER BY created_at, rowid LIMIT 1').get(sessionId))
      if (!storage || !row) return
      const pending = pendingTurnSchema.parse(JSON.parse(row.facts))
      const repository = this.deps.repositories.named(storage.repository)
      // The repository is the truth for its head: a commit can land before the row that records it.
      const head = await repository.head()
      const manifest = head ? await repository.readManifest(head) : emptySessionManifest(sessionId, pending.organizationId)
      const commit = manifest.turns.some((turn) => turn.operationId === row.operation_id)
        ? head
        : await this.commitTurn(repository, head, manifest, row.operation_id, pending)
      await this.giveTurnDiff(manifest, row.operation_id, pending)
      withTx(() => {
        db.prepare('UPDATE session_storage SET head = ?, turn_count = ?, error = NULL WHERE session_id = ?').run(commit, manifest.turns.length, sessionId)
        db.prepare('DELETE FROM session_storage_turns WHERE operation_id = ?').run(row.operation_id)
      })
      this.deps.onCommit?.(sessionId)
    }
  }

  /**
   * The mirror gets the diff of a committed turn before its pending row goes,
   * so a restart between the two gives it again. A failure leaves the turn
   * with no diff for readers; it never holds the commit back.
   */
  private async giveTurnDiff(manifest: SessionManifest, operationId: string, pending: PendingTurn): Promise<void> {
    const turnIndex = manifest.turns.findIndex((turn) => turn.operationId === operationId)
    if (turnIndex < 0 || !pending.checkout || !this.deps.turnDiff) return
    const sessionId = manifest.session.id
    await this.deps.turnDiff({ sessionId, turnIndex, endedAt: pending.endedAt, repoRoot: pending.checkout.repoRoot, snapshots: manifest.turns[turnIndex]!.snapshots }).catch((error) => {
      log.warn('session_turn_diff_failed', { sessionId, turnIndex, error: error instanceof Error ? error.message : String(error) })
    })
  }

  /** Build and write the commit of one turn; answers the head after it. A turn with nothing new writes no commit. */
  private async commitTurn(repository: SessionRepository, head: string | null, manifest: SessionManifest, operationId: string, pending: PendingTurn): Promise<string | null> {
    const index = manifest.turns.length
    const scratch = await mkdtemp(join(tmpdir(), 'solus-session-turn-'))
    try {
      // The first commit of a turn in several commits needs a manifest: a reader of each head reads one.
      const manifestBefore = head ? null : JSON.stringify(manifest)
      const entries = threadEntries(manifest, index, pending)
      const turn: SessionManifestTurn = {
        operationId, endedAt: pending.endedAt, provider: pending.provider, threadId: pending.threadId, partial: pending.partial,
        head: pending.checkout ? { sha: pending.checkout.headSha, branch: pending.checkout.branch } : null,
        snapshots: [], bundle: null, hasDiff: false,
      }
      if (pending.checkout) await this.storeCode(repository, manifest, turn, pending.checkout, scratch)
      // A turn that changed files is recorded although no file of the commit is new: its snapshots are in the manifest.
      const changedFiles = turn.snapshots.length > 0 && turn.snapshots[0]!.fromTreeSha !== turn.snapshots.at(-1)!.toTreeSha
      if (!entries.length && !changedFiles && turn.bundle?.kind !== 'stored') return head
      writeSessionFacts(manifest, pending)
      manifest.turns.push(turn)
      try {
        return await repository.commit({ expectedHead: head, ...turnCommits(`Solus session turn ${index} ${operationId}`, entries, manifest, manifestBefore) })
      } catch (error) {
        // Only this writer commits to a local copy. A moved head is a commit of this turn that already landed; the next pass reads it.
        if (error instanceof SessionHeadMovedError) log.warn('session_repository_head_moved', { sessionId: manifest.session.id })
        throw error
      }
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  }

  /** Keep the code bundle of the snapshots this turn adds under its code ref, with their facts written into `turn` and `manifest.project`. */
  private async storeCode(repository: SessionRepository, manifest: SessionManifest, turn: SessionManifestTurn, checkout: NonNullable<PendingTurn['checkout']>, scratch: string): Promise<void> {
    const sessionId = manifest.session.id
    const baseSha = getSessionBaseSha(checkout.repoRoot, sessionId)
    if (!baseSha) return
    const committed = manifest.turns.flatMap((earlier) => earlier.snapshots)
    const snapshots: TurnSnapshot[] = (await listTurnSnapshots(checkout.repoRoot, sessionId)).slice(committed.length, checkout.snapshotCount)
    const lastHead = manifest.turns.map((earlier) => earlier.head?.sha).filter(Boolean).at(-1)
    const previousCommit = committed.at(-1)?.sha ?? baseSha
    manifest.project = {
      repositoryKey: await resolveRepositoryKey(checkout.repoRoot).catch(() => null),
      baseSha,
      ownsWorktree: checkout.workTree !== resolve(checkout.repoRoot),
    }
    turn.snapshots = snapshots
    const bundleFile = join(scratch, 'turn.bundle')
    const bundle: TurnCodeBundle | { kind: 'failed' } = await writeTurnCodeBundle(checkout.repoRoot, {
      sessionId, snapshots, previousCommit, headSha: checkout.headSha,
      carried: [...new Set([committed.at(-1)?.sha, lastHead].filter((sha): sha is string => !!sha))],
    }, bundleFile).catch((error) => {
      // The thread of the turn is still worth a commit; a host that syncs sees that the code state is absent.
      log.warn('session_code_bundle_failed', { sessionId, error: error instanceof Error ? error.message : String(error) })
      return { kind: 'failed' as const }
    })
    turn.bundle = bundle.kind === 'written' ? { kind: 'stored', ...await repository.storeCodeBundle(bundleFile), refs: bundle.refs } : bundle
  }
}

/** The session facts of the turn that ended last, in the manifest of version 2 that its commit writes. */
function writeSessionFacts(manifest: SessionManifest, pending: PendingTurn): void {
  manifest.schemaVersion = 2
  Object.assign(manifest.session, {
    title: pending.title ?? null, model: pending.model ?? null,
    reasoningEffort: pending.reasoningEffort ?? null, permissionMode: pending.permissionMode ?? null,
    startedBy: pending.startedBy ?? null, parentSessionId: pending.parentSessionId ?? null,
    rootSessionId: pending.rootSessionId ?? null,
  })
  manifest.lineage = pending.lineage ?? manifest.lineage ?? []
  manifest.sessionPaths = pending.sessionPaths ?? manifest.sessionPaths ?? { turnPaths: [], sessionChangedFiles: [] }
  manifest.lastProjectRoot = pending.lastProjectRoot ?? null
  for (const thread of manifest.threads) thread.startedAs = manifest.lineage.find((member) => member.threadId === thread.threadId)?.startedAs
}

function manifestLineage(members: SessionLineageMember[], turn: TurnEnd, isFork: boolean): NonNullable<PendingTurn['lineage']> {
  if (!members.length) return [{ threadId: turn.threadId, provider: turn.provider, startedAs: isFork ? 'fork' : 'start' }]
  return members.map((member, index) => ({
    threadId: member.providerSessionId ?? (index === members.length - 1 ? turn.threadId : ''),
    provider: member.provider, startedAs: index > 0 ? 'handoff' as const : isFork ? 'fork' as const : 'start' as const,
  })).filter((member) => member.threadId)
}

/**
 * The bytes each provider file gained after the last turn commit, as entries
 * of turn `index` in pieces `<index>.<piece>`. Updates the files of the thread in `manifest`.
 */
function threadEntries(manifest: SessionManifest, index: number, pending: PendingTurn): GitFileEntry[] {
  const entries: GitFileEntry[] = []
  for (const file of pending.files) {
    let thread = manifest.threads.find((candidate) => candidate.threadId === pending.threadId)
    if (!thread) {
      thread = { threadId: pending.threadId, provider: pending.provider, files: [] }
      manifest.threads.push(thread)
    }
    let known: SessionManifestThreadFile | undefined = thread.files.find((candidate) => candidate.relativePath === file.relativePath)
    if (!known) {
      known = { key: unusedKey(thread.files, file.key), relativePath: file.relativePath, length: 0, parts: [] }
      thread.files.push(known)
    }
    // A provider only appends. A shorter file is a new file with the same name, and starts again under a new key.
    if (file.length < known.length) Object.assign(known, { key: unusedKey(thread.files, `${file.key}-${index}`), length: 0, parts: [] })
    if (file.length === known.length) continue
    for (let from = known.length, piece = 0; from < file.length; from += THREAD_PIECE_BYTES, piece++) {
      entries.push({ path: `threads/${pending.threadId}/${known.key}/${index}.${piece}`, file: file.path, from, to: Math.min(file.length, from + THREAD_PIECE_BYTES) })
      known.parts.push(`${index}.${piece}`)
    }
    known.length = file.length
  }
  return entries
}

/**
 * The commits of one turn: the entries in order, in groups of at most `COMMIT_BYTES`.
 * The last commit writes `manifest`. An earlier commit keeps the manifest of its
 * parent; the first commit of a repository writes `manifestBefore`.
 */
function turnCommits(message: string, entries: GitFileEntry[], manifest: SessionManifest, manifestBefore: string | null): Omit<TurnCommit, 'expectedHead'> {
  const groups: GitFileEntry[][] = [[]]
  let size = 0
  for (const entry of entries) {
    const bytes = 'content' in entry ? Buffer.byteLength(entry.content) : (entry.to ?? 0) - (entry.from ?? 0)
    if (size + bytes > COMMIT_BYTES && groups.at(-1)!.length) { groups.push([]); size = 0 }
    groups.at(-1)!.push(entry)
    size += bytes
  }
  const earlier = groups.slice(0, -1).map((group, part) => ({ message: `${message} part ${part + 1}`, entries: group }))
  if (manifestBefore && earlier[0]) earlier[0].entries.push({ path: 'manifest.json', content: manifestBefore })
  return { message, entries: [...groups.at(-1)!, { path: 'manifest.json', content: JSON.stringify(manifest) }], earlier }
}

/** `key`, or `key` with a number after it when another file of the thread has that key: two files must never share a folder. */
function unusedKey(files: SessionManifestThreadFile[], key: string): string {
  const taken = new Set(files.map((file) => file.key))
  let candidate = key
  for (let suffix = 2; taken.has(candidate); suffix++) candidate = `${key}-${suffix}`
  return candidate
}

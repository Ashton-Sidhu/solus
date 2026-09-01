import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Database, type SQLQueryBindings } from 'bun:sqlite'
import type { ChangedFileStat, GitState, UncommittedFile } from '@solus/contracts/git-types'
import type { ReviewGuide } from '@solus/contracts/review'
import type { SessionLoadMessage } from '@solus/contracts/session-history'
import type { Task, TaskCommentData, TaskSessionLink } from '@solus/contracts/task-types'
import type {
  Automation,
  AutomationRun,
  PlanAnnotations,
  PlanDescriptor,
  SessionMeta,
  WorkAnnotations,
  WorkMeta,
  WorkPrevious,
} from '@solus/contracts/types'
import { DEMO_PROJECT, type DemoFixtures } from '../apps/client/src/demo/fixtures/types'

const FIXED_NEWEST_TIMESTAMP = Date.parse('2026-01-15T15:00:00.000Z')
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi

interface Args {
  workspace: string
  out: string
  sessions?: string[]
  base?: string
}

interface JsonlRecord {
  type?: string
  uuid?: string
  slug?: string
  cwd?: string
  timestamp?: string
  isMeta?: boolean
  isSidechain?: boolean
  parent_tool_use_id?: string
  message?: { content?: JsonValue }
}

interface DbRow { [key: string]: string | number | null }

/** Any value that survives a `JSON.parse` round trip. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** A JSON object, before any of its fields have been decoded. */
type JsonObject = { [key: string]: JsonValue }

/**
 * Claude writes JSONL whose block payloads are untyped. These decoders are the I/O
 * boundary: they turn a raw JSON value into a domain value or `null`, so the rest of
 * the script never branches on a representation.
 */
function textOf(value: JsonValue | undefined): string | null {
  return Object.prototype.toString.call(value) === '[object String]' ? String(value) : null
}

function objectOf(value: JsonValue | undefined): JsonObject | null {
  if (Object.prototype.toString.call(value) !== '[object Object]') return null
  // SAFETY: the tag check above accepted only plain objects, which JSON parses as
  // string-keyed maps of further JSON values.
  return value as JsonObject
}

function blocksOf(value: JsonValue | undefined): JsonObject[] {
  return Array.isArray(value) ? value.map(objectOf).filter((block) => block !== null) : []
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (!flag?.startsWith('--')) throw new Error(`Unexpected argument: ${flag}`)
    const value = argv[++i]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`)
    values.set(flag, value)
  }
  const workspace = values.get('--workspace')
  const out = values.get('--out')
  if (!workspace || !out) {
    throw new Error('Usage: bun scripts/capture-demo-fixtures.ts --workspace <projectPath> [--sessions <id1,id2,...>] [--base <ref>] --out <directory>')
  }
  const sessions = values.get('--sessions')?.split(',').map((id) => id.trim()).filter(Boolean)
  return { workspace: resolve(workspace), out: resolve(out), sessions, base: values.get('--base') }
}

function assertReadOnlySource(workspace: string, out: string): void {
  if (!existsSync(workspace)) throw new Error(`Workspace does not exist: ${workspace}`)
  const rel = relative(workspace, out)
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) {
    throw new Error(`Refusing to write capture output inside source workspace: ${out}`)
  }
}

function git(workspace: string, args: string[]): string {
  return execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 })
}

function encodePathAsFolder(path: string): string {
  // Keep in sync with src/shared/types.ts:encodePathAsFolder.
  return path.replace(/[^a-zA-Z0-9]/g, '-')
}

function extractPromptText(content: string): string {
  const args = content.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim()
  if (args) return args
  const command = content.match(/<command-name>\s*([^<\s]+)\s*<\/command-name>/)?.[1]?.trim()
  const stripped = content
    .replaceAll(/<command-(?:name|message)>[\s\S]*?<\/command-(?:name|message)>/g, '')
    .replaceAll(/<command-args>[\s\S]*?<\/command-args>/g, '')
    .trim()
  return stripped || command || ''
}

function stripInjectedContext(text: string): string {
  const index = text.search(/\[Referenced Plan:|\[Referenced Work:|\[Working On /)
  return index === -1 ? text : text.slice(0, index).trimEnd()
}

// Ported from claude-session-helpers.ts. Importing that module also initializes
// main-process caches and backend utilities, which a standalone capture script
// should not load.
function parseJsonlRecord(obj: JsonlRecord): SessionLoadMessage | null {
  const parentToolUseId = obj.parent_tool_use_id || undefined
  const timestamp = new Date(obj.timestamp ?? 0).getTime()
  if (!Number.isFinite(timestamp)) return null
  const content = obj.message?.content
  const contentText = textOf(content)
  const blocks = blocksOf(content)
  if (obj.type === 'user') {
    if (obj.isMeta) return null
    if (blocks.length > 0 && blocks.every((block) => block.type === 'tool_result')) {
      const result = blocks.find((block) => textOf(block.tool_use_id) !== null)
      const toolResultForId = result ? textOf(result.tool_use_id) : null
      if (!result || !toolResultForId) return null
      const text = textOf(result.content)
        ?? blocksOf(result.content).map((block) => textOf(block.text) ?? '').join('\n')
      return { role: 'tool_result', content: text, toolResultForId, parentToolUseId, timestamp }
    }
    if (contentText?.includes('<task-notification>')) {
      const toolId = contentText.match(/<tool-use-id>([^<]+)<\/tool-use-id>/)?.[1]
      const result = contentText.match(/<result>([\s\S]*?)<\/result>/)?.[1]?.trim()
      return toolId && result ? { role: 'assistant', content: result, parentToolUseId: toolId, timestamp } : null
    }
    let text = ''
    if (contentText !== null) {
      if (contentText.includes('This session is being continued from a previous conversation')) return null
      text = extractPromptText(contentText)
    } else {
      text = blocks.filter((block) => block.type === 'text').map((block) => textOf(block.text) ?? '').join('\n')
    }
    text = stripInjectedContext(text)
    return text ? { role: 'user', content: text, parentToolUseId, timestamp } : null
  }
  if (obj.type !== 'assistant' || !Array.isArray(content)) return null
  for (const block of blocks) {
    const blockText = textOf(block.text)
    if (block.type === 'text' && blockText) {
      return { role: 'assistant', content: blockText, parentToolUseId, timestamp }
    }
    const toolName = textOf(block.name)
    const toolInput = objectOf(block.input)
    const planContent = textOf(toolInput?.plan)
    if (block.type === 'tool_use' && toolName === 'ExitPlanMode' && planContent) {
      return {
        role: 'plan', content: '', planContent,
        planFilePath: textOf(toolInput?.planFilePath) ?? '', planToolUseId: textOf(block.id) ?? '',
        parentToolUseId, timestamp,
      }
    }
    if (block.type === 'tool_use' && toolName) {
      return {
        role: 'tool', content: '', toolName, toolId: textOf(block.id) ?? undefined,
        toolInput: JSON.stringify(block.input ?? {}), parentToolUseId, timestamp,
      }
    }
  }
  return null
}

async function captureSessions(args: Args): Promise<DemoFixtures['sessions']> {
  const encodedPath = encodePathAsFolder(args.workspace)
  const dir = join(homedir(), '.claude', 'projects', encodedPath)
  if (!existsSync(dir)) return []
  const candidates = (await Promise.all((await readdir(dir))
    .filter((name) => name.endsWith('.jsonl'))
    .map(async (name) => ({ name, mtime: (await stat(join(dir, name))).mtimeMs }))))
    .sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name))
  const ids = args.sessions?.length ? args.sessions : candidates.slice(0, 1).map(({ name }) => name.slice(0, -6))
  const sessions: DemoFixtures['sessions'] = []
  for (const sessionId of [...ids].sort()) {
    const path = join(dir, `${sessionId}.jsonl`)
    if (!existsSync(path)) throw new Error(`Claude session not found: ${path}`)
    const raw = await readFile(path, 'utf8')
    const records: JsonlRecord[] = []
    const messages: SessionLoadMessage[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        // SAFETY: `JsonlRecord` declares every field optional, so any parsed JSON object
        // satisfies it; a line that is not an object is dropped by the catch below.
        const record = JSON.parse(line) as JsonlRecord
        records.push(record)
        const message = parseJsonlRecord(record)
        if (message) messages.push(message)
      } catch {}
    }
    const firstUser = messages.find((message) => message.role === 'user')?.content ?? null
    const firstRecord = records.find((record) => record.uuid && record.timestamp)
    const fileStat = await stat(path)
    const meta: SessionMeta = {
      provider: 'claude-code', sessionId,
      slug: records.find((record) => record.slug)?.slug ?? null,
      firstMessage: firstUser?.slice(0, 100) ?? null,
      lastTimestamp: new Date(messages.at(-1)?.timestamp ?? fileStat.mtimeMs).toISOString(),
      size: fileStat.size,
      cwd: records.find((record) => record.cwd)?.cwd ?? args.workspace,
      projectPath: encodedPath,
      status: 'idle',
    }
    if (!firstRecord && messages.length === 0) continue
    sessions.push({ meta, messages })
  }
  return sessions.sort((a, b) => a.meta.sessionId.localeCompare(b.meta.sessionId))
}

function parseNameStatus(text: string): Map<string, ChangedFileStat['status']> {
  const statuses = new Map<string, ChangedFileStat['status']>()
  for (const line of text.split('\n').filter(Boolean)) {
    const [code, ...paths] = line.split('\t')
    const status: ChangedFileStat['status'] =
      code?.startsWith('R') ? 'R' : code === 'A' ? 'A' : code === 'D' ? 'D' : 'M'
    const path = paths[paths.length - 1]
    if (path) statuses.set(path, status)
  }
  return statuses
}

function parseNumstat(text: string, statuses?: Map<string, ChangedFileStat['status']>): ChangedFileStat[] {
  return text.split('\n').filter(Boolean).map((line) => {
    const [additions, deletions, ...pathParts] = line.split('\t')
    const path = pathParts.join('\t')
    return { path, additions: Number(additions) || 0, deletions: Number(deletions) || 0, status: statuses?.get(path) ?? 'M' as const }
  }).sort((a, b) => a.path.localeCompare(b.path))
}

function captureDiffs(args: Args): DemoFixtures['diffs'] {
  const variants: Array<[string, string[]]> = [['working-tree', ['HEAD']]]
  if (args.base) variants.push([`base:${args.base}`, [args.base]])
  return Object.fromEntries(variants.map(([key, revision]) => {
    const patch = git(args.workspace, ['diff', '--binary', '--no-ext-diff', ...revision])
    const statuses = parseNameStatus(git(args.workspace, ['diff', '--name-status', '--no-ext-diff', ...revision]))
    const stats = parseNumstat(git(args.workspace, ['diff', '--numstat', '--no-ext-diff', ...revision]), statuses)
    return [key, { patch, stats, turnSnapshots: [], changedFiles: stats.map(({ path }) => path) }]
  }))
}

function captureGitStatus(args: Args): GitState {
  const text = git(args.workspace, ['status', '--porcelain=v2', '--branch'])
  let branch: string | null = null
  const files: UncommittedFile[] = []
  for (const line of text.split('\n')) {
    if (line.startsWith('# branch.head ')) branch = line.slice('# branch.head '.length) === '(detached)' ? null : line.slice('# branch.head '.length)
    else if (line.startsWith('? ') || line.startsWith('! ')) files.push({ path: line.slice(2), conflicted: false })
    else if (line.startsWith('1 ')) {
      const fields = line.split(' ')
      files.push({ path: fields.slice(8).join(' '), conflicted: fields[1]?.includes('U') ?? false })
    } else if (line.startsWith('2 ')) {
      const current = line.split('\t')[0]!.split(' ').slice(9).join(' ')
      files.push({ path: current, conflicted: false })
    } else if (line.startsWith('u ')) {
      files.push({ path: line.split(' ').slice(10).join(' '), conflicted: true })
    }
  }
  const stats = parseNumstat(git(args.workspace, ['diff', 'HEAD', '--numstat', '--no-ext-diff']))
  const mergeHead = git(args.workspace, ['rev-parse', '--git-path', 'MERGE_HEAD']).trim()
  const tryGit = (gitArgs: string[]): string | null => {
    try { return git(args.workspace, gitArgs).trim() } catch { return null }
  }
  const targetBranch = args.base ?? 'main'
  const upstreamRef = tryGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  const [behindCount, aheadCount] = (tryGit(['rev-list', '--left-right', '--count', '@{u}...HEAD']) ?? '0\t0')
    .split('\t').map((count) => Number(count) || 0)
  return {
    repoRoot: git(args.workspace, ['rev-parse', '--show-toplevel']).trim(),
    headSha: git(args.workspace, ['rev-parse', 'HEAD']).trim(),
    branch,
    targetBranch,
    uncommittedChanges: {
      files: files.sort((a, b) => a.path.localeCompare(b.path)),
      hasMoreFiles: false,
      insertions: stats.reduce((sum, file) => sum + file.additions, 0),
      deletions: stats.reduce((sum, file) => sum + file.deletions, 0),
      mergeInProgress: existsSync(isAbsolute(mergeHead) ? mergeHead : join(args.workspace, mergeHead)),
    },
    upstreamRef,
    aheadCount: aheadCount ?? 0,
    behindCount: behindCount ?? 0,
    targetAheadCount: Number(tryGit(['rev-list', '--count', `${targetBranch}..HEAD`])) || 0,
  }
}

function openSidecarDb(): Database | null {
  const path = join(process.env.SOLUS_DATA_DIR ?? join(homedir(), '.solus'), 'solus.db')
  return existsSync(path) ? new Database(path, { readonly: true, strict: true }) : null
}

function query(db: Database | null, sql: string, params: SQLQueryBindings[] = []): DbRow[] {
  if (!db) return []
  try {
    // SAFETY: `strict: true` makes bun:sqlite return one plain object per row whose
    // values are the SQLite storage classes `DbRow` enumerates.
    return db.query(sql).all(...params) as DbRow[]
  } catch { return [] }
}

function projectKey(workspace: string): string {
  let root = workspace
  try { root = git(workspace, ['rev-parse', '--show-toplevel']).trim() } catch {}
  const marker = `${sep}.git${sep}solus${sep}worktrees${sep}`
  if (root.includes(marker)) root = root.slice(0, root.indexOf(marker))
  return createHash('sha256').update(root).digest('hex')
}

function parseJson<T>(value: JsonValue, fallback: T): T {
  const text = textOf(value)
  if (text === null) return fallback
  try {
    // SAFETY: each caller names the column's declared JSON payload type as `T`; a
    // column holding anything else throws and falls back below.
    return JSON.parse(text) as T
  } catch { return fallback }
}

function capturePlans(sessions: DemoFixtures['sessions'], db: Database | null): DemoFixtures['plans'] {
  const annotations = new Map(query(db, 'SELECT * FROM plan_annotations').map((row) => {
    // SAFETY: `plan_annotations.status` is written only from `PlanAnnotations['status']`.
    const status = row.status as PlanAnnotations['status']
    const ann: PlanAnnotations = {
      version: 1, sessionId: String(row.session_id), projectPath: String(row.project_path), cwd: String(row.cwd),
      planToolUseId: String(row.plan_tool_use_id), title: String(row.title),
      status, comments: parseJson(row.comments, []),
      bookmarked: row.bookmarked === 1,
      updatedAt: Number(row.updated_at),
    }
    if (row.bookmarked_at !== null) ann.bookmarkedAt = Number(row.bookmarked_at)
    return [`${ann.sessionId}__${ann.planToolUseId}`, ann]
  }))
  const plans: DemoFixtures['plans'] = []
  for (const session of sessions) for (const message of session.messages) {
    if (message.role !== 'plan' || !message.planToolUseId || !message.planContent) continue
    const key = `${session.meta.sessionId}__${message.planToolUseId}`
    const title = message.planContent.match(/^#\s+(.+)$/m)?.[1] ?? message.planContent.split('\n').find(Boolean)?.slice(0, 80) ?? 'Plan'
    const annotation = annotations.get(key) ?? {
      version: 1, sessionId: session.meta.sessionId, projectPath: session.meta.projectPath,
      cwd: session.meta.cwd, planToolUseId: message.planToolUseId, title,
      status: 'pending', comments: [], bookmarked: false, updatedAt: message.timestamp,
    }
    const descriptor: PlanDescriptor = {
      provider: 'claude-code', planToolUseId: message.planToolUseId, sessionId: session.meta.sessionId,
      projectPath: session.meta.projectPath, cwd: session.meta.cwd, timestamp: message.timestamp,
      title: annotation.title || title, excerpt: message.planContent.replace(/\s+/g, ' ').slice(0, 180),
      status: annotation.status, commentCount: annotation.comments.length, bookmarked: annotation.bookmarked,
      revisions: [],
    }
    if (annotation.bookmarkedAt !== undefined) descriptor.bookmarkedAt = annotation.bookmarkedAt
    if (message.planFilePath) descriptor.planFilePath = message.planFilePath
    plans.push({ descriptor, content: message.planContent, annotations: annotation })
  }
  return plans.sort((a, b) => a.descriptor.planToolUseId.localeCompare(b.descriptor.planToolUseId))
}

async function captureWorks(workspace: string, db: Database | null): Promise<DemoFixtures['works']> {
  const works: DemoFixtures['works'] = []
  const annotationRows = new Map(query(db, 'SELECT work_id, data FROM work_annotations').map((row) => [String(row.work_id), parseJson<WorkAnnotations | undefined>(row.data, undefined)]))
  for (const row of query(db, "SELECT * FROM works WHERE storage = 'local' AND cwd = ?", [workspace])) {
    const extra = parseJson<Partial<WorkMeta>>(row.meta, {})
    // SAFETY: `works.type` is written only from `WorkMeta['type']`.
    const type = row.type as WorkMeta['type']
    // SAFETY: `works.agent_provider` is written only from `WorkMeta['agentProvider']`.
    const agentProvider = row.agent_provider as WorkMeta['agentProvider']
    const meta: WorkMeta & { id: string } = {
      ...extra, id: String(row.id), title: String(row.title ?? ''), preview: String(row.preview ?? ''),
      type, createdAt: new Date(Number(row.created_at)).toISOString(),
      updatedAt: new Date(Number(row.updated_at)).toISOString(), sessionId: row.session_id ? String(row.session_id) : undefined,
      agentProvider, cwd: String(row.cwd), storage: { kind: 'local' },
    }
    if (row.pinned !== null) meta.pinned = row.pinned === 1
    works.push({ meta, content: String(row.content ?? ''), annotations: annotationRows.get(meta.id) })
  }
  const root = join(workspace, '.solus', 'works')
  const manifestPath = join(root, 'works-manifest.json')
  if (existsSync(manifestPath)) {
    const manifest = parseJson<{ works: Record<string, WorkMeta> }>(await readFile(manifestPath, 'utf8'), { works: {} })
    for (const [id, storedMeta] of Object.entries(manifest.works).sort(([a], [b]) => a.localeCompare(b))) {
      const current = parseJson<{ content: string }>(await readFile(join(root, `${id}.json`), 'utf8'), { content: '' })
      let previous: WorkPrevious | undefined
      const previousPath = join(root, `${id}.prev.json`)
      if (existsSync(previousPath)) previous = parseJson<WorkPrevious | undefined>(await readFile(previousPath, 'utf8'), undefined)
      // SAFETY: the manifest key is the work id, so spreading it over the stored meta
      // produces a `WorkMeta` that carries its id.
      const meta = { ...storedMeta, id } as WorkMeta & { id: string }
      works.push({ meta, content: current.content, annotations: annotationRows.get(id), previous })
    }
  }
  // SAFETY: every entry pushed above was built with an `id`.
  return works.sort((a, b) => (a.meta as WorkMeta & { id: string }).id.localeCompare((b.meta as WorkMeta & { id: string }).id))
}

function rowToTask(row: DbRow): Task {
  // SAFETY: `tasks.kind` is written only from `Task['kind']`.
  const kind = row.kind as Task['kind']
  // SAFETY: `tasks.status` is written only from `Task['status']`.
  const status = row.status as Task['status']
  // SAFETY: `tasks.priority` is written only from `Task['priority']`.
  const priority = row.priority as Task['priority']
  return {
    id: String(row.id), providerId: 'local', kind, title: String(row.title),
    body: String(row.body ?? ''), status, url: null,
    assignee: row.assignee ? String(row.assignee) : undefined, labels: parseJson(row.labels, []),
    parentId: row.parent_id ? String(row.parent_id) : undefined, dueDate: row.due_date ? String(row.due_date) : undefined,
    priority, branch: row.branch ? String(row.branch) : undefined,
    pr: parseJson(row.pr, undefined), canEditPlanningFields: true,
    updatedAt: Number(row.updated_at), raw: parseJson(row.raw, null),
  }
}

function captureTasks(workspace: string, db: Database | null): DemoFixtures['tasks'] {
  const key = projectKey(workspace)
  let tasks = query(db, 'SELECT * FROM tasks WHERE project_key = ? ORDER BY updated_at DESC, id', [key]).map(rowToTask)
  let fetchedAt = FIXED_NEWEST_TIMESTAMP
  if (tasks.length === 0) {
    const cache = query(db, 'SELECT * FROM task_cache WHERE project_key = ?', [key])[0]
    tasks = parseJson<{ tasks?: Task[] }>(cache?.tasks, {}).tasks ?? []
    fetchedAt = Number(cache?.fetched_at) || fetchedAt
  }
  const details = Object.fromEntries(tasks.map((task) => [task.id, task]))
  const comments = Object.fromEntries(tasks.map((task) => {
    // SAFETY: the local task provider stores its comment list on `raw.comments`.
    const raw = task.raw as { comments?: TaskCommentData[] } | null
    return [task.id, raw?.comments ?? []]
  }))
  const sessions: Record<string, TaskSessionLink[]> = {}
  for (const row of query(db, 'SELECT * FROM task_session_links WHERE project_key = ? ORDER BY linked_at, rowid', [key])) {
    const id = String(row.task_id)
    ;(sessions[id] ??= []).push({
      sessionId: String(row.session_id),
      sessionTitle: row.session_title ? String(row.session_title) : null,
      provider: row.provider ? String(row.provider) : null,
      lastActivityAt: row.last_activity_at ? Number(row.last_activity_at) : null,
      linkedAt: Number(row.linked_at),
    })
  }
  return { list: { tasks: tasks.sort((a, b) => a.id.localeCompare(b.id)), fromCache: false, fetchedAt }, details, comments, sessions }
}

function captureAutomations(workspace: string, db: Database | null): DemoFixtures['automations'] {
  const list: Automation[] = query(db, 'SELECT * FROM automations ORDER BY id').map((row) => {
    // SAFETY: the columns below cover every required `Automation` field, and
    // `last_run` holds the remaining optional fields this row last reported.
    const automation = {
      ...parseJson<Partial<Automation>>(row.last_run, {}), id: String(row.id), name: String(row.name), enabled: row.enabled === 1,
      action: parseJson(row.action, {}),
      trigger: parseJson(row.trigger_config, { type: 'manual' }),
      createdAt: new Date(Number(row.created_at)).toISOString(), updatedAt: new Date(Number(row.updated_at)).toISOString(),
    } as Automation
    if (row.favorite !== null) automation.favorite = row.favorite === 1
    if (row.next_run_at !== null) automation.nextRunAt = new Date(Number(row.next_run_at)).toISOString()
    return automation
  }).filter((automation) => resolve(automation.action.cwd) === workspace)
  const runs: Record<string, AutomationRun[]> = {}
  for (const automation of list) {
    runs[automation.id] = query(db, 'SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC, id', [automation.id]).map((row) => {
      // SAFETY: `automation_runs.status` is written only from `AutomationRun['status']`,
      // and `data` holds the remaining optional fields of the recorded run.
      const run = {
        ...parseJson<Partial<AutomationRun>>(row.data, {}), id: String(row.id), automationId: String(row.automation_id),
        startedAt: new Date(Number(row.started_at)).toISOString(),
        status: row.status,
      } as AutomationRun
      if (row.finished_at !== null) run.finishedAt = new Date(Number(row.finished_at)).toISOString()
      if (row.output !== null) run.output = String(row.output)
      return run
    })
  }
  return { list, runs }
}

async function capturePr(workspace: string): Promise<DemoFixtures['pr']> {
  const reviewDir = join(workspace, '.solus', 'review')
  let guide: ReviewGuide | null = null
  if (existsSync(reviewDir)) {
    const files = (await Promise.all((await readdir(reviewDir)).filter((name) => name.endsWith('.json')).map(async (name) => ({ name, mtime: (await stat(join(reviewDir, name))).mtimeMs }))))
      .sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name))
    for (const file of files) {
      guide = parseJson<ReviewGuide | null>(await readFile(join(reviewDir, file.name), 'utf8'), null)
      if (guide?.version === 1) break
    }
  }
  const timestamp = new Date(FIXED_NEWEST_TIMESTAMP).toISOString()
  const emptyGuide: ReviewGuide = guide ?? { version: 1, key: 'demo-review', headSha: '', baseSha: '', title: 'Demo review', summary: 'No captured review guide.', sections: [] }
  return {
    list: [], overview: { pullRequest: {
      number: 0, url: 'https://github.com/acme/acme/pull/0',
      baseRepo: { host: 'github.com', owner: 'acme', repo: 'acme' },
      title: 'Captured workspace', author: 'demo', authorAvatarUrl: '', state: 'open', createdAt: timestamp,
      updatedAt: timestamp, draft: false, labels: [], additions: 0, deletions: 0, body: '', baseRef: 'main',
      headRef: 'demo', baseSha: emptyGuide.baseSha, headSha: emptyGuide.headSha, changedFiles: 0,
      mergeable: null, mergeStateStatus: null, headRepo: { owner: 'acme', repo: 'acme', isFork: false },
      capabilities: {
        diff: true, diffFileContents: true, inlineComments: true, threadReplies: true, threadResolution: true,
        reviewVerdicts: ['comment', 'approve', 'request-changes'], actions: ['merge'],
        mergeMethods: ['merge', 'squash', 'rebase'], reviewerRequests: false, reviewerCandidates: false,
      },
      viewerPermissions: {
        actions: ['merge'], reviewVerdicts: ['comment', 'approve', 'request-changes'],
        comment: true, resolveThreads: true, requestReviewers: false,
      },
    }, commits: [], reviewers: [] }, changedFiles: [], threads: [], guide: emptyGuide, filePatches: {},
  }
}

function sanitizeString(value: string, workspace: string): string {
  const home = homedir()
  const username = basename(home)
  const usernamePattern = new RegExp(username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
  return value
    .replaceAll(workspace, DEMO_PROJECT)
    .replaceAll(home, '/home/demo')
    .replaceAll(encodePathAsFolder(workspace), encodePathAsFolder(DEMO_PROJECT))
    .replace(usernamePattern, 'demo')
    .replaceAll(EMAIL_RE, '[redacted-email]')
    .replace(/(?:https?:\/\/|git@)github\.com[/:][^\s/'"]+\/[^\s/'"#]+/gi, 'https://github.com/acme/acme')
    .replace(/github\.com\/[\w.-]+\/[\w.-]+/gi, 'github.com/acme/acme')
}

const TIME_KEYS = /(?:timestamp|(?:created|updated|started|finished|fetched|linked|bookmarked|nextRun|lastRun|committed|pinned)At)$/i

/** A captured fixture tree is plain JSON, so both walkers below branch on JSON kinds. */
function numberOf(value: JsonValue): number | null {
  return Object.prototype.toString.call(value) === '[object Number]' ? Number(value) : null
}

function normalizeAndSanitize<T>(input: T, workspace: string): T {
  // SAFETY: every caller passes a value that was produced by `JSON.parse` or is about to
  // be written with `JSON.stringify`, so it is already a JSON tree.
  const root = input as JsonValue
  const timestamps: number[] = []
  function collect(value: JsonValue, key = ''): void {
    const record = objectOf(value)
    if (Array.isArray(value)) value.forEach((item) => collect(item, key))
    else if (record) Object.entries(record).forEach(([childKey, child]) => collect(child, childKey))
    else if (TIME_KEYS.test(key)) {
      const text = textOf(value)
      const timestamp = numberOf(value) ?? (text === null ? NaN : Date.parse(text))
      if (Number.isFinite(timestamp)) timestamps.push(timestamp)
    }
  }
  collect(root)
  const shift = timestamps.length ? FIXED_NEWEST_TIMESTAMP - Math.max(...timestamps) : 0
  function visit(value: JsonValue, key = ''): JsonValue {
    const text = textOf(value)
    if (text !== null) {
      if (TIME_KEYS.test(key) && Number.isFinite(Date.parse(text))) return new Date(Date.parse(text) + shift).toISOString()
      return sanitizeString(text, workspace)
    }
    const numeric = numberOf(value)
    if (numeric !== null && TIME_KEYS.test(key) && Number.isFinite(numeric)) return numeric + shift
    if (Array.isArray(value)) return value.map((item) => visit(item, key))
    const record = objectOf(value)
    if (record) {
      return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)).map(([childKey, child]) => [sanitizeString(childKey, workspace), visit(child, childKey)]))
    }
    return value
  }
  // SAFETY: `visit` rebuilds the tree key-for-key, so the result keeps the input's type.
  return visit(root) as T
}

async function writeJson<T>(path: string, value: T): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  assertReadOnlySource(args.workspace, args.out)
  const db = openSidecarDb()
  try {
    const sessions = await captureSessions(args)
    const plans = capturePlans(sessions, db)
    const fixtures: DemoFixtures = {
      startInfo: {
        version: 'demo', projectPath: DEMO_PROJECT, homePath: '/home/demo', workspacePath: DEMO_PROJECT,
        agents: [{ id: 'claude-code', label: 'Claude Code', models: [], defaultModel: '', available: true }],
      },
      persistedTabs: { version: 1, activeTabId: '', tabOrder: [], tabs: [] },
      sessions, plans, works: await captureWorks(args.workspace, db), pr: await capturePr(args.workspace),
      tasks: captureTasks(args.workspace, db), automations: captureAutomations(args.workspace, db),
      diffs: captureDiffs(args), gitStatus: captureGitStatus(args), replayScript: [],
      // The browsable project tree is authored in apps/client/src/demo/fixtures/project-files.ts.
      files: { root: DEMO_PROJECT, files: [], contents: {} },
    }
    const captured = normalizeAndSanitize(fixtures, args.workspace)
    await mkdir(args.out, { recursive: true })
    const domains = {
      'sessions.json': captured.sessions, 'plans.json': captured.plans, 'works.json': captured.works,
      'pr.json': captured.pr, 'tasks.json': captured.tasks, 'automations.json': captured.automations,
      'diffs.json': captured.diffs, 'git-status.json': captured.gitStatus, 'manifest.json': captured,
    }
    for (const [name, value] of Object.entries(domains).sort(([a], [b]) => a.localeCompare(b))) await writeJson(join(args.out, name), value)
    console.log(`Captured ${captured.sessions.length} session(s) to ${args.out}`)
  } finally {
    db?.close()
  }
}

await main()

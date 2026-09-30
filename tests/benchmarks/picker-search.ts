/**
 * Session picker search: speed and relevance.
 *
 * Run with: bun tests/benchmarks/picker-search.ts
 * Record a new "before": bun tests/benchmarks/picker-search.ts --record-baseline
 * A heavy user's index: bun tests/benchmarks/picker-search.ts --scale 10
 *   (about ten times the messages; compared with `picker-search-baseline-x10.json`)
 *
 * The corpus is synthetic and seeded, so every run reads the same data: 1,200
 * tasks whose titles and bodies share a small vocabulary (the noise a real
 * board has), their sessions, and a transcript for each session in a temporary
 * session index. A handful of targets are planted in it, each with the query a
 * person would type to find it.
 *
 * - Speed: the host's index search as the picker calls it, and the client's
 *   list build for every keystroke of a typed query.
 * - Relevance: where each target lands in the keyboard order of the list the
 *   picker builds from both — hit@1, hit@3, and mean reciprocal rank.
 *
 * "Before" is the recorded baseline in `picker-search-baseline.json`. Nothing
 * here touches live Solus data or starts the app.
 */
import { plugin } from 'bun'
import { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionLoadMessage } from '@solus/contracts/session-history'
import type { Task, TaskStatus } from '@solus/contracts/task-types'
import { encodePathAsFolder, type SessionSearchResult } from '@solus/contracts/types'
import type { SidebarSessionChild } from '@solus/workspace-ui/contexts/workspace/session-sidebar.store.svelte'
import { buildPickerRows, type PickerEntry } from '@solus/workspace-ui/components/session/unified-picker/lib/picker-rows'

// The host's DB layer imports `node:sqlite`, which Bun does not provide;
// bun:sqlite answers the calls the indexer makes.
plugin({
  setup(build) {
    build.module('node:sqlite', () => ({ exports: { DatabaseSync: Database }, loader: 'object' }))
  },
})

const dataDir = mkdtempSync(join(tmpdir(), 'solus-picker-bench-'))
process.env.SOLUS_DATA_DIR = dataDir
const indexer = await import('@solus/server/db/session-indexer')
const search = await import('@solus/server/db/session-search')
const { closeDb, withTx } = await import('@solus/server/db')

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

function medianMs(fn: () => void, runs = 15, warmup = 3): number {
  for (let i = 0; i < warmup; i++) fn()
  const samples: number[] = []
  for (let i = 0; i < runs; i++) {
    const start = performance.now()
    fn()
    samples.push(performance.now() - start)
  }
  samples.sort((a, b) => a - b)
  return samples[Math.floor(samples.length / 2)]!
}

/** Deterministic, so the corpus is the same on every run. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 2 ** 32
  }
}
const rand = random(42)
const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!

// ---------------------------------------------------------------------------
// corpus
// ---------------------------------------------------------------------------

const NOW = Date.UTC(2026, 8, 30)
const DAY = 86_400_000
const CWD = '/Users/bench/solus'
const PROJECT = encodePathAsFolder(CWD)

const VERBS = ['Fix', 'Add', 'Improve', 'Refactor', 'Remove', 'Investigate', 'Polish', 'Speed up', 'Document', 'Test', 'Migrate', 'Redesign']
const AREAS = [
  'session picker', 'sidebar', 'websocket', 'diff viewer', 'task board', 'automations', 'settings', 'keybindings',
  'transcript', 'preview pane', 'worktree', 'git status', 'pull request', 'review guide', 'voice dictation',
  'browser pane', 'tab strip', 'command palette', 'mobile layout', 'dark mode', 'onboarding', 'auth token',
  'rate limits', 'insights', 'folio works', 'diagram canvas', 'plan gallery', 'tray icon', 'update checker',
  'search index', 'table rendering', 'tables export', 'session reconnect', 'reconnect banner', 'picker footer',
]
const QUALIFIERS = ['on mobile', 'after reconnect', 'in split view', 'for remote hosts', 'when offline', 'in dark mode', 'under load', 'for Codex', 'for Claude', 'on first launch', '', '', '', '']
const PROBLEMS = ['jumps', 'flickers', 'is slow', 'loses focus', 'shows stale data', 'crashes', 'drops input', 'renders twice', 'ignores the scope', 'misses results']
const ACTIONS = ['types quickly', 'switches tabs', 'reconnects', 'opens the picker', 'scrolls the list', 'resizes the window', 'changes project', 'starts a session']
const FILLER = [
  'We need to check the {area} before the release.', 'The {area} {problem} when the user {action}.',
  'I looked at the logs and the {area} path is the likely cause.', 'Let me read the {area} store and its callers first.',
  'The test covers the {area} but not the case where it {problem}.', 'Can you fix the {area} and run the focused tests?',
  'Done. The {area} no longer {problem}, and the tests pass.', 'The session and the task both show the {area} state.',
]
const STATUSES: TaskStatus[] = ['in_progress', 'in_progress', 'todo', 'todo', 'inbox', 'done', 'done', 'done']

function sentence(): string {
  return pick(FILLER)
    .replace('{area}', pick(AREAS))
    .replace('{problem}', pick(PROBLEMS))
    .replace('{action}', pick(ACTIONS))
}

function title(): string {
  return `${pick(VERBS)} ${pick(AREAS)} ${pick(QUALIFIERS)}`.trim()
}

function makeTask(index: number, fields: Partial<Task> = {}): Task {
  const updatedAt = NOW - Math.floor(rand() * 180 * DAY)
  return {
    id: `task-${index}`,
    shortId: index + 1,
    title: title(),
    body: Array.from({ length: 3 + Math.floor(rand() * 10) }, sentence).join(' '),
    status: pick(STATUSES),
    priority: null,
    projectKey: CWD,
    providerId: 'local',
    createdAt: updatedAt - DAY,
    updatedAt,
    ...fields,
  } as Task
}

function makeChild(sessionId: string, label: string, lastActivityAt: number): SidebarSessionChild {
  return {
    sessionId, label, lastActivityAt,
    branchName: null, attention: null, unread: false, serverId: 'local', runStartedAt: 0, reviewGuideStatus: null,
  }
}

const tasks: Task[] = []
const sessionsByTaskId = new Map<string, SidebarSessionChild[]>()
const transcripts = new Map<string, string[]>()
let sessionCounter = 0

function addSession(task: Task | null, label: string, lines: string[] = [], lastActivityAt = task?.updatedAt ?? NOW): string {
  const sessionId = `session-${sessionCounter++}`
  const count = 16 + Math.floor(rand() * 30)
  const texts = Array.from({ length: count }, () => Array.from({ length: 1 + Math.floor(rand() * 4) }, sentence).join(' '))
  // A planted line sits in the middle of the conversation, where it is found by what was said.
  texts.splice(Math.floor(count / 2), 0, ...lines)
  transcripts.set(sessionId, texts)
  if (task) {
    const children = sessionsByTaskId.get(task.id) ?? []
    children.push(makeChild(sessionId, label, lastActivityAt))
    sessionsByTaskId.set(task.id, children)
  }
  return sessionId
}

for (let index = 0; index < 1200; index++) {
  const task = makeTask(index)
  tasks.push(task)
  const sessionCount = rand() < 0.25 ? 0 : 1 + Math.floor(rand() * 3)
  for (let s = 0; s < sessionCount; s++) {
    addSession(task, s === 0 ? task.title : `${pick(VERBS)} ${pick(AREAS)}`, [], task.updatedAt - s * DAY)
  }
}
// Sessions no task claims: found only by what was said in them.
for (let index = 0; index < 400; index++) addSession(null, '')
// A heavy user's index: many more conversations of the same kind.
const SCALE = Number(process.argv[process.argv.indexOf('--scale') + 1]) || 1
for (let index = 0; index < (SCALE - 1) * 2200; index++) addSession(null, '')
/** Names and branches the host keeps for a session, planted after the index is written. */
const sessionNames = new Map<string, { title?: string; branch?: string }>()

// ── planted targets ──
let plantedIndex = 5000
function plant(fields: Partial<Task>): Task {
  const task = makeTask(plantedIndex++, fields)
  tasks.push(task)
  return task
}

interface Target {
  /** What the person types. */
  query: string
  /** Why this query is here, printed with its result. */
  intent: string
  /** Entries that count as finding it: the task row, or one of its sessions. */
  keys: string[]
}
const targets: Target[] = []

{
  // A short exact title, older than the long titles that contain it.
  const onboarding = plant({ title: 'Onboarding', status: 'todo', updatedAt: NOW - 60 * DAY })
  for (let i = 0; i < 12; i++) plant({ title: `Polish onboarding ${pick(QUALIFIERS) || 'copy'} ${i}`, updatedAt: NOW - i * DAY })
  targets.push({ query: 'onboarding', intent: 'exact short title under newer longer ones', keys: [`task:${onboarding.id}`] })
}
{
  // A session named for the words, under a task named for something else, while many task titles hold the same words apart.
  const owner = plant({ title: 'Investigate flaky e2e runs', updatedAt: NOW - 25 * DAY })
  const sessionId = addSession(owner, 'Websocket reconnect loop', [], NOW - 25 * DAY)
  for (let i = 0; i < 14; i++) plant({ title: `Fix websocket ${pick(['sidebar', 'picker', 'insights'])} after reconnect ${i}`, updatedAt: NOW - i * DAY })
  targets.push({ query: 'websocket reconnect', intent: 'session name buried under task titles', keys: [`session:session:${sessionId}`] })
}
{
  // A whole word against words that only start with it.
  const tab = plant({ title: 'Tab strip overflow menu', status: 'in_progress', updatedAt: NOW - 30 * DAY })
  for (let i = 0; i < 10; i++) plant({ title: `Fix table ${pick(['sorting', 'export', 'rendering'])} ${i}`, updatedAt: NOW - i * DAY })
  targets.push({ query: 'tab', intent: 'whole word over prefix matches', keys: [`task:${tab.id}`] })
}
{
  // The human id.
  const byId = tasks[41]!
  targets.push({ query: 'T-42', intent: 'task by its id', keys: [`task:${byId.id}`] })
}
{
  // Two tasks with the same title: the one in progress now, not the one done months ago.
  const recent = plant({ title: 'Update dependencies', status: 'in_progress', updatedAt: NOW - 2 * DAY })
  plant({ title: 'Update dependencies', status: 'done', updatedAt: NOW - 90 * DAY })
  targets.push({ query: 'update dep', intent: 'same title: current over done', keys: [`task:${recent.id}`] })
}
{
  // Only what was said names it.
  const sessionId = addSession(null, '', ['We should write the pelican migration plan before touching the schema.'])
  targets.push({ query: 'pelican migration', intent: 'conversation found by its words', keys: [`session:session:${sessionId}`] })
}
{
  // A session named for the words, typed half-way.
  const owner = plant({ title: 'Polish usage meters', updatedAt: NOW - 40 * DAY })
  const sessionId = addSession(owner, 'Rate limit banner copy', [], NOW - 40 * DAY)
  targets.push({ query: 'rate lim ban', intent: 'session name typed half-way', keys: [`session:session:${sessionId}`] })
}
{
  // A task title that starts with the query, older than titles that hold its words later on.
  const target = plant({ title: 'Diff viewer word wrap', status: 'todo', updatedAt: NOW - 50 * DAY })
  for (let i = 0; i < 8; i++) plant({ title: `Speed up the diff viewer for large files and word ${i}`, updatedAt: NOW - i * DAY })
  targets.push({ query: 'diff viewer word', intent: 'title that starts with the query', keys: [`task:${target.id}`] })
}
{
  // A body is the only place the words are.
  const target = plant({ title: 'Investigate startup hang', body: 'Startup stalls while the SQLite WAL checkpoint runs on a large database.', updatedAt: NOW - 70 * DAY })
  targets.push({ query: 'wal checkpoint', intent: 'task found by its body', keys: [`task:${target.id}`] })
}
{
  // A task and its session named alike: either row is the thing.
  const target = plant({ title: 'Tray icon blurry on retina', status: 'in_progress', updatedAt: NOW - 20 * DAY })
  const sessionId = addSession(target, 'Tray icon blurry on retina', [], NOW - 20 * DAY)
  for (let i = 0; i < 6; i++) plant({ title: `Fix tray icon ${pick(QUALIFIERS) || 'menu'} ${i}`, updatedAt: NOW - i * DAY })
  targets.push({ query: 'tray icon blurry', intent: 'task and its like-named session', keys: [`task:${target.id}`, `session:session:${sessionId}`] })
}
{
  // A session whose words are an exact phrase, among sessions that hold them apart.
  const sessionId = addSession(null, '', ['The flaky reconnect test fails because the retry timer is shared.'])
  for (let i = 0; i < 20; i++) addSession(null, '', [`The test for the reconnect path is flaky ${i} and the sidebar reconnect is fine.`])
  targets.push({ query: 'flaky reconnect test', intent: 'exact phrase in a conversation', keys: [`session:session:${sessionId}`] })
}
{
  // A session title the person remembers, under a task with a different name, with many content hits too.
  const owner = plant({ title: 'Improve session picker search', status: 'in_progress', updatedAt: NOW - 3 * DAY })
  const sessionId = addSession(owner, 'Picker relevance benchmark', [], NOW - 3 * DAY)
  targets.push({ query: 'picker relevance', intent: 'session title among content hits', keys: [`session:session:${sessionId}`] })
}
{
  // A session no task claims, found by its title alone: the words were never said in it.
  const sessionId = addSession(null, '')
  sessionNames.set(sessionId, { title: 'Keyboard cheatsheet overlay' })
  targets.push({ query: 'cheatsheet overlay', intent: 'unclaimed session by its title only', keys: [`session:session:${sessionId}`] })
}
{
  // A session found by its branch.
  const sessionId = addSession(null, '')
  sessionNames.set(sessionId, { branch: 'fix/ws-jitter-backoff' })
  targets.push({ query: 'jitter backoff', intent: 'session by its branch', keys: [`session:session:${sessionId}`] })
}
{
  // The words are in two different messages of one session.
  const sessionId = addSession(null, '', ['The lighthouse audit failed on the landing page.', 'Then we added a stricter cache header to fix it.'])
  targets.push({ query: 'lighthouse cache header', intent: 'words across two messages of a session', keys: [`session:session:${sessionId}`] })
}

// ── held out: written after the ranking, and not tuned against ──
{
  const websocket = targets.find((target) => target.query === 'websocket reconnect')!
  targets.push({ query: 'reconnect websocket', intent: 'held out: a name with its words reversed', keys: websocket.keys })
  const onboarding = targets.find((target) => target.query === 'onboarding')!
  targets.push({ query: 'ONBOARDING', intent: 'held out: a name typed in capitals', keys: onboarding.keys })
  const tab = targets.find((target) => target.query === 'tab')!
  targets.push({ query: 'overflow menu', intent: 'held out: the end of a title', keys: tab.keys })
  const e2e = tasks.find((task) => task.title === 'Investigate flaky e2e runs')!
  targets.push({ query: 'flaky e2e', intent: 'held out: a task among conversations that say "flaky"', keys: [`task:${e2e.id}`] })
}

// ── the host's index ──
withTx(() => {
  for (const [sessionId, texts] of transcripts) {
    indexer.persistIndexedSessionStart(sessionId, 'claude-code', CWD, PROJECT, 'claude-opus-5-5', 'high', texts[0] ?? null, sessionNames.get(sessionId)?.branch ?? null)
    const messages: SessionLoadMessage[] = texts.map((content, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content,
      timestamp: NOW - 200 * DAY + index * 60_000,
    }))
    indexer.indexSessionMessages(sessionId, messages)
  }
})
for (const [sessionId, { title }] of sessionNames) if (title) await indexer.setSessionCustomTitle(sessionId, title)
const messageCount = [...transcripts.values()].reduce((sum, texts) => sum + texts.length, 0)

/** The picker's call: the first page of sessions that match, in one project
 *  when scoped — the picker opens scoped to the composer's. */
function hostSearch(query: string, projectRoot?: string): SessionSearchResult[] {
  return search.searchSessionIndex(query, { projectRoot, limit: 30 }).results.map((result) => {
    result.session.serverId = 'local'
    return result
  })
}

function buildList(query: string, conversations: readonly SessionSearchResult[]) {
  return buildPickerRows({
    tasks,
    query,
    sessionsFor: (task) => sessionsByTaskId.get(task.id) ?? [],
    expandedTaskIds: new Set(),
    openTaskIds: new Set(),
    conversations,
  })
}

// ---------------------------------------------------------------------------
// speed
// ---------------------------------------------------------------------------

interface Metric {
  name: string
  unit: string
  value: number
}
const metrics: Metric[] = []
const record = (name: string, unit: string, value: number) => metrics.push({ name, unit, value })

const SERVER_QUERIES = ['the', 'session', 'sess', 'websocket reconnect', 'fix sidebar scroll', 'pelican']
for (const query of SERVER_QUERIES) {
  record(`host search "${query}" (${messageCount} messages)`, 'ms', medianMs(() => hostSearch(query)))
}
for (const query of ['the', 'sess', 'websocket reconnect']) {
  record(`host search "${query}" in one project`, 'ms', medianMs(() => hostSearch(query, CWD)))
}
// Keywords mode reads names only; the list's end reads the next page.
record('host search "sess", names only', 'ms', medianMs(() => search.searchSessionIndex('sess', { namesOnly: true, limit: 30 })))
record('host search "the", second page', 'ms', medianMs(() => search.searchSessionIndex('the', { limit: 30, offset: 30 })))

// Every keystroke of a query as it is typed, against the list the picker
// builds each time: the name pass over every task and its sessions.
const TYPED = 'session picker search'
const prefixes = Array.from({ length: TYPED.length }, (_, i) => TYPED.slice(0, i + 1)).filter((prefix) => prefix.trim() === prefix)
const hitsByPrefix = new Map(prefixes.map((prefix) => [prefix, hostSearch(prefix)]))
const perKeystroke = prefixes.map((prefix) => medianMs(() => buildList(prefix, hitsByPrefix.get(prefix)!), 25, 5))
record(`client list build per keystroke, mean (${tasks.length} tasks)`, 'ms', perKeystroke.reduce((a, b) => a + b, 0) / perKeystroke.length)
record(`client list build per keystroke, worst (${tasks.length} tasks)`, 'ms', Math.max(...perKeystroke))
record('client list build, no query', 'ms', medianMs(() => buildList('', [])))

// ---------------------------------------------------------------------------
// relevance
// ---------------------------------------------------------------------------

function entryKeys(entry: PickerEntry): string[] {
  if (entry.kind === 'task') return [`task:${entry.task.id}`]
  if (entry.kind === 'session') return [`session:session:${entry.session.sessionId}`]
  return [`session:session:${entry.meta.sessionId}`]
}

const positions = targets.map((target) => {
  const { entries } = buildList(target.query, hostSearch(target.query))
  const at = entries.findIndex((entry) => entryKeys(entry).some((key) => target.keys.includes(key)))
  return { target, position: at < 0 ? null : at + 1, listed: entries.length }
})
// `--explain "<query>"` prints the first rows of one query's list, to see why a target is where it is.
const explain = process.argv.includes('--explain') ? process.argv[process.argv.indexOf('--explain') + 1] : undefined
if (explain) {
  const { entries } = buildList(explain, hostSearch(explain))
  for (const entry of entries.slice(0, 8)) {
    const label = entry.kind === 'task' ? `task  ${entry.task.title}` : entry.kind === 'session' ? `sess  ${entry.session.label} (task: ${entry.task.title})` : `conv  ${entry.meta.customTitle ?? entry.meta.firstMessage?.slice(0, 60)}`
    console.log(`${entry.entryIndex + 1}. ${label}`)
  }
}
const reciprocal = positions.map(({ position }) => (position ? 1 / position : 0))
record(`relevance hit@1 (${targets.length} queries)`, 'ratio', positions.filter(({ position }) => position === 1).length / targets.length)
record(`relevance hit@3 (${targets.length} queries)`, 'ratio', positions.filter(({ position }) => position !== null && position <= 3).length / targets.length)
record(`relevance MRR (${targets.length} queries)`, 'ratio', reciprocal.reduce((a, b) => a + b, 0) / targets.length)
for (const { target, position } of positions) {
  record(`position of "${target.query}" — ${target.intent}`, 'rank', position ?? Number.POSITIVE_INFINITY)
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

closeDb()
rmSync(dataDir, { recursive: true, force: true })

const here = new URL('.', import.meta.url).pathname
const baselinePath = join(here, SCALE === 1 ? 'picker-search-baseline.json' : `picker-search-baseline-x${SCALE}.json`)
if (process.argv.includes('--record-baseline')) {
  writeFileSync(baselinePath, JSON.stringify(metrics, null, 2))
  console.log('Recorded', baselinePath)
}
const baseline = new Map<string, number>(
  existsSync(baselinePath) ? (JSON.parse(readFileSync(baselinePath, 'utf8')) as Metric[]).map((metric) => [metric.name, metric.value]) : [],
)
const format = (value: number | undefined, unit: string) =>
  value === undefined ? '—' : !Number.isFinite(value) ? 'missing' : unit === 'ms' ? `${value.toFixed(2)} ms` : unit === 'rank' ? `#${value}` : value.toFixed(2)
const rows = metrics.map((metric) => ({
  metric: metric.name,
  before: format(baseline.get(metric.name), metric.unit),
  after: format(metric.value, metric.unit),
}))
console.table(rows)
writeFileSync(join(here, SCALE === 1 ? 'picker-search-results.json' : `picker-search-results-x${SCALE}.json`), JSON.stringify(metrics, null, 2))

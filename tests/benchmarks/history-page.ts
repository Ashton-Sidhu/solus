/**
 * History page build: what one page of an older session costs, on the host and
 * in the client, stage by stage. Answers one question: does building a page
 * block the client's main thread long enough to need yielding?
 *
 * Run with: bun tests/benchmarks/history-page.ts [--runs 15]
 *
 * Fixtures are the session-open Claude transcripts (`session-open-fixtures.ts`)
 * in a disposable HOME, plus one long agentic session. The host stages are the
 * real `loadSessionPage` pipeline; the client stages are the real
 * `materializeSessionTranscript`, the prepend into a `$state` transcript, and
 * the work after it (agent-conversation index, changed files, turns). The
 * Svelte stages run on Svelte's real client runtime. No benchmark touches live
 * Solus data or starts the app.
 *
 * Times are the median of the runs. CPU is process CPU time for the stage
 * (user + system); the work is single-threaded, so CPU close to wall means the
 * stage holds the thread the whole time. Retained is the heap growth the page
 * leaves behind after a full GC. Peak allocation is not reported: JSC's heap
 * size moves only at a collection, and the allocator reuses memory it already
 * holds, so neither shows a stage's transient garbage.
 */
import { heapSize } from 'bun:jsc'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcContext, Message } from '@solus/contracts/types'
import type { SessionHistoryPage } from '@solus/contracts/session-history'
import { encodePathAsFolder } from '@solus/contracts/types'
import { INITIAL_HISTORY_TURNS, OLDER_HISTORY_TURNS } from '@solus/client-core/session-history-page'
import { loadClaudeHistoryPage } from '@solus/server/execution/agents/claude/claude-history-page'
import { projectSessionHistory } from '@solus/server/data/sessions/result-projection'
import { deferSessionToolInputs } from '@solus/server/data/sessions/session-tool-inputs'
import { materializeSessionTranscript } from '@solus/workspace-ui/contexts/workspace/session-transcript'
import { TranscriptAgentConversations } from '@solus/workspace-ui/contexts/workspace/agent-conversation-cards'
import { extractChangedFilePaths } from '@solus/workspace-ui/lib/changedFiles'
import type { WorkspaceContext } from '@solus/workspace-ui/contexts/workspace/workspace.context.svelte'
import { SvelteRunes } from '../unit/helpers/svelte-runes'
import { SHAPES, writeFixtures } from './session-open-fixtures'

const argv = process.argv.slice(2)
const RUNS = Number(argv[argv.indexOf('--runs') + 1] || 15)

// The worst older page: an agentic session long enough for a full 20-turn page behind its first one.
SHAPES.push({ key: 'agentic-long', title: 'Bench long agentic session', turns: 40, toolsPerTurn: 75 })

const runes = new SvelteRunes()
const turns = SvelteRunes.file('packages/workspace-ui/src/components/conversation/lib/turns.ts')
const artifacts = SvelteRunes.file('packages/workspace-ui/src/components/conversation/lib/artifact-revisions.ts')
const navigation = runes.source('navigation', 'packages/workspace-ui/src/components/conversation/lib/transcript-navigation.ts', { './turns': turns })
const transcriptTurns = runes.source('transcript-turns', 'packages/workspace-ui/src/components/conversation/lib/transcript-turns.svelte.ts', {
  './turns': turns, './transcript-navigation': navigation, './artifact-revisions': artifacts,
})
// A mounted conversation: the transcript in `$state`, its turns read from an
// effect the way the view's template reads them.
const chains = runes.module('history-chains', `
  import { flushSync } from 'svelte'
  import { TranscriptTurns } from ${JSON.stringify(transcriptTurns)}

  export function conversation(messages) {
    const state = $state({ messages })
    const transcript = new TranscriptTurns(() => state.messages, () => false)
    let sink = 0
    const dispose = $effect.root(() => {
      $effect(() => { sink += transcript.turns.length })
    })
    flushSync()
    return { state, flush: flushSync, dispose }
  }
`)
const { conversation } = await import(chains) as {
  conversation(messages: Message[]): { state: { messages: Message[] }; flush(): void; dispose(): void }
}

// ---------------------------------------------------------------------------
// measurement
// ---------------------------------------------------------------------------

interface Sample { wallMs: number; cpuMs: number }
const mb = (bytes: number): number => bytes / 1024 / 1024
const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

/** One run of a stage. `prepare` runs outside the measurement. */
async function sample<T, R>(prepare: () => T | Promise<T>, stage: (input: T) => R | Promise<R>): Promise<{ sample: Sample; result: R }> {
  const input = await prepare()
  Bun.gc(true)
  const cpuBefore = process.cpuUsage()
  const started = performance.now()
  const result = await stage(input)
  const wallMs = performance.now() - started
  const cpu = process.cpuUsage(cpuBefore)
  return { sample: { wallMs, cpuMs: (cpu.user + cpu.system) / 1000 }, result }
}

async function stageStats<T, R>(prepare: () => T | Promise<T>, stage: (input: T) => R | Promise<R>) {
  const samples: Sample[] = []
  for (let run = 0; run < 3; run++) await sample(prepare, stage)
  for (let run = 0; run < RUNS; run++) samples.push((await sample(prepare, stage)).sample)
  return {
    wallMs: median(samples.map((s) => s.wallMs)),
    maxWallMs: Math.max(...samples.map((s) => s.wallMs)),
    cpuMs: median(samples.map((s) => s.cpuMs)),
  }
}

/** Heap a value keeps alive once built, after a full GC. */
async function retainedMb<R>(build: () => R | Promise<R>): Promise<number> {
  Bun.gc(true)
  const before = heapSize()
  const kept = await build()
  Bun.gc(true)
  const after = heapSize()
  void kept
  return mb(after - before)
}

// ---------------------------------------------------------------------------
// the pipeline
// ---------------------------------------------------------------------------

const ctx = {
  apiForSession: () => ({}),
  automationsStore: { items: [], loaded: true },
  worksStore: { works: {}, get: () => undefined },
  planStore: { upsertFromHistory: () => 'plan' },
} as unknown as WorkspaceContext

/** The host side of `loadSessionPage`: read, project, defer inputs, encode. */
async function hostPage(file: string, turnLimit: number, before?: string): Promise<string> {
  const loaded = await loadClaudeHistoryPage(file, turnLimit, before)
  return JSON.stringify({ messages: deferSessionToolInputs(projectSessionHistory(loaded.messages)), before: loaded.before })
}

function materialize(page: SessionHistoryPage, before?: string) {
  return materializeSessionTranscript(ctx, {
    sessionId: 'bench', loadPath: '/repo', displayCwd: '/repo', provider: 'claude-code',
    ctx: { session: { sessionId: 'bench-tab' } } as IpcContext, serverId: 'bench-host', before,
    turnLimit: before ? OLDER_HISTORY_TURNS : INITIAL_HISTORY_TURNS,
  }, page)
}

/** What `prependHistoryPage` does after the page arrives, on a mounted conversation. */
function prepend(view: ReturnType<typeof conversation>, older: Message[]): void {
  for (let end = older.length; end > 0; end -= 1000) {
    view.state.messages.unshift(...older.slice(Math.max(0, end - 1000), end))
  }
  new TranscriptAgentConversations(view.state.messages)
  extractChangedFilePaths(view.state.messages)
  view.flush()
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

const home = mkdtempSync(join(tmpdir(), 'solus-history-bench-'))
const projectDir = join(home, 'repo')
const fixtures = writeFixtures(home, projectDir)
const fileOf = (sessionId: string): string => join(home, '.claude', 'projects', encodePathAsFolder(projectDir), `${sessionId}.jsonl`)

interface Row {
  fixture: string; page: string; messages: number; wireKb: number
  host: Awaited<ReturnType<typeof stageStats>>; parse: Awaited<ReturnType<typeof stageStats>>
  materialize: Awaited<ReturnType<typeof stageStats>>; apply: Awaited<ReturnType<typeof stageStats>>
  retainedMb: number
}
const rows: Row[] = []

try {
  for (const fixture of fixtures.filter((f) => ['typical', 'heavy', 'agentic', 'huge', 'agentic-long'].includes(f.key))) {
    const file = fileOf(fixture.sessionId)
    const first = JSON.parse(await hostPage(file, INITIAL_HISTORY_TURNS)) as SessionHistoryPage
    const pages: Array<{ name: string; turnLimit: number; before?: string; base: Message[] }> = [
      { name: `first (${INITIAL_HISTORY_TURNS} turns)`, turnLimit: INITIAL_HISTORY_TURNS, base: [] },
    ]
    if (first.before) {
      pages.push({ name: `older (${OLDER_HISTORY_TURNS} turns)`, turnLimit: OLDER_HISTORY_TURNS, before: first.before, base: materialize(first).messages })
    }
    for (const page of pages) {
      const wire = await hostPage(file, page.turnLimit, page.before)
      const parsed = JSON.parse(wire) as SessionHistoryPage
      const host = await stageStats(() => undefined, () => hostPage(file, page.turnLimit, page.before))
      const parse = await stageStats(() => undefined, () => JSON.parse(wire))
      const built = await stageStats(() => JSON.parse(wire) as SessionHistoryPage, (input) => materialize(input, page.before))
      const apply = await stageStats(
        () => ({ view: conversation(structuredClone(page.base)), older: materialize(JSON.parse(wire), page.before).messages }),
        ({ view, older }) => { page.base.length ? prepend(view, older) : (view.state.messages.push(...older), view.flush()); view.dispose() },
      )
      const retained = await retainedMb(() => materialize(JSON.parse(wire), page.before))
      rows.push({
        fixture: fixture.key, page: page.name, messages: parsed.messages.length, wireKb: wire.length / 1024,
        host, parse, materialize: built, apply, retainedMb: retained,
      })
    }
  }
} finally {
  rmSync(home, { recursive: true, force: true })
  rmSync(runes.directory, { recursive: true, force: true })
}

const f = (n: number, digits = 1): string => n.toFixed(digits)
console.log(`\nHistory page build, median of ${RUNS} runs (max wall in brackets). Times in ms, memory in MB.\n`)
console.log('| Fixture | Page | Rows | Wire KB | Host wall / CPU | Client parse | Client build | Client apply | Client total (max) | Client CPU | Retained |')
console.log('|---|---|---|---|---|---|---|---|---|---|---|')
for (const row of rows) {
  const clientWall = row.parse.wallMs + row.materialize.wallMs + row.apply.wallMs
  const clientMax = row.parse.maxWallMs + row.materialize.maxWallMs + row.apply.maxWallMs
  const clientCpu = row.parse.cpuMs + row.materialize.cpuMs + row.apply.cpuMs
  console.log(`| ${row.fixture} | ${row.page} | ${row.messages} | ${f(row.wireKb, 0)} | ${f(row.host.wallMs)} / ${f(row.host.cpuMs)} | ${f(row.parse.wallMs)} | ${f(row.materialize.wallMs)} | ${f(row.apply.wallMs)} | ${f(clientWall)} (${f(clientMax)}) | ${f(clientCpu)} | ${f(row.retainedMb, 2)} |`)
}

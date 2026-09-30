/**
 * Transcript and tab-pool benchmarks: segment-local turns, turn-sized history
 * pages, and the bounded conversation pool.
 *
 * Run with: bun tests/benchmarks/transcript.ts
 *
 * Timings run on Svelte's real client runtime and read the transcript from an
 * effect, the way the view's template does. "Before" is the recorded baseline
 * in `transcript-baseline.json`: the whole-transcript build, 200-row history
 * pages, and every visited tab mounted. That code is deleted; its numbers
 * were measured on the same fixtures before it was. No benchmark touches live
 * Solus data or starts the app.
 */
import { heapSize } from 'bun:jsc'
import { readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from '@solus/contracts/types'
import type { SessionLoadMessage } from '@solus/contracts/session-history'
import { INITIAL_HISTORY_TURNS } from '@solus/client-core/session-history-page'
import { loadClaudeHistoryPage } from '@solus/server/execution/agents/claude/claude-history-page'
import { projectSessionHistory } from '@solus/server/data/sessions/result-projection'
import { deferSessionToolInputs } from '@solus/server/data/sessions/session-tool-inputs'
import { SvelteRunes } from '../unit/helpers/svelte-runes'
import { MAX_MOUNTED_CONVERSATIONS, mountedConversationTabIds } from '@solus/workspace-ui/components/conversation/lib/conversation-pool'

const runes = new SvelteRunes()
const turns = SvelteRunes.file('packages/workspace-ui/src/components/conversation/lib/turns.ts')
const artifacts = SvelteRunes.file('packages/workspace-ui/src/components/conversation/lib/artifact-revisions.ts')
const navigation = runes.source('navigation', 'packages/workspace-ui/src/components/conversation/lib/transcript-navigation.ts', { './turns': turns })
const transcriptTurns = runes.source('transcript-turns', 'packages/workspace-ui/src/components/conversation/lib/transcript-turns.svelte.ts', {
  './turns': turns, './transcript-navigation': navigation, './artifact-revisions': artifacts,
})

// Everything the view derives from the transcript on every change: the turns,
// the message → turn index Find and the navigator use, the virtualizer's row
// keys, and the artifact revision index.
const chains = runes.module('chains', `
  import { flushSync } from 'svelte'
  import { createArtifactRevisionIndexer } from ${JSON.stringify(artifacts)}
  import { TranscriptTurns } from ${JSON.stringify(transcriptTurns)}

  export function conversation(messages, running) {
    const state = $state({ messages, running })
    const transcript = new TranscriptTurns(() => state.messages, () => state.running)
    const index = createArtifactRevisionIndexer()
    let sink = 0
    const dispose = $effect.root(() => {
      const keys = $derived(transcript.turns.map((turn) => turn.id))
      const revisions = $derived(index(transcript.segments.flatMap((segment) => segment.artifacts)))
      $effect(() => { sink += (transcript.messageTurns.get('m1') ? 1 : 0) + keys.length + revisions.size })
    })
    flushSync()
    return { state, flush: flushSync, dispose }
  }

  export function reactive(value) {
    const state = $state({ value })
    return state
  }
`)

type Conversation = { state: { messages: Message[]; running: boolean }; flush(): void; dispose(): void }
const { conversation, reactive } = await import(chains) as {
  conversation(messages: Message[], running: boolean): Conversation
  reactive<T>(value: T): { value: T }
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

let clock = 1_700_000_000_000
let nextId = 0
function msg(partial: Partial<Message> & Pick<Message, 'role'>): Message {
  clock += 1000
  return { id: `m${++nextId}`, content: '', timestamp: clock, ...partial }
}
const prose = 'The change touches the reducer and the view. '.repeat(10)

/** A long working session: each turn is a prompt, narration, six tool calls,
 *  and an answer. The last turn is still streaming its answer. */
function session(messageCount: number): Message[] {
  const messages: Message[] = []
  while (messages.length < messageCount - 9) {
    messages.push(msg({ role: 'user', content: 'Fix the failing test and explain the cause.' }))
    messages.push(msg({ role: 'assistant', content: 'Reading the test first.' }))
    for (let i = 0; i < 6; i++) {
      messages.push(msg({
        role: 'tool', toolName: i % 2 ? 'Edit' : 'Read', toolStatus: 'completed',
        toolInput: JSON.stringify({ file_path: `/repo/src/file-${i}.ts`, old_string: prose + nextId, new_string: prose }),
        content: prose + nextId,
      }))
    }
    messages.push(msg({ role: 'assistant', content: prose + nextId }))
  }
  messages.push(msg({ role: 'user', content: 'Now the docs.' }))
  for (let i = 0; i < 6; i++) messages.push(msg({ role: 'tool', toolName: 'Read', toolStatus: 'completed', toolInput: '{}' }))
  messages.push(msg({ role: 'assistant', content: 'Streaming' }))
  return messages
}

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

interface Result { name: string; unit: string; before: number; after: number; note?: string }
const baseline = new Map<string, number>(
  (JSON.parse(readFileSync(new URL('./transcript-baseline.json', import.meta.url), 'utf8')) as {
    results: Array<{ name: string; before: number }>
  }).results.map((row) => [row.name, row.before]),
)
const results: Result[] = []
function recorded(name: string, unit: string, after: number, note?: string): void {
  const before = baseline.get(name)
  if (before === undefined) throw new Error(`No recorded baseline for "${name}"`)
  results.push({ name, unit, before, after, note })
}

function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/** Median time of one `step`, measured `steps` times on one conversation. */
function perStep(size: number, steps: number, step: (view: Conversation) => void): number {
  const view = conversation(session(size), true)
  for (let i = 0; i < 20; i++) { step(view); view.flush() }
  const samples: number[] = []
  for (let i = 0; i < steps; i++) {
    const start = performance.now()
    step(view)
    view.flush()
    samples.push(performance.now() - start)
  }
  view.dispose()
  return median(samples)
}

const streamToken = (view: Conversation) => { view.state.messages[view.state.messages.length - 1].content += ' token' }
const appendTool = (view: Conversation) => {
  view.state.messages.push(msg({ role: 'tool', toolName: 'Read', toolStatus: 'completed', toolInput: '{}' }))
}
const buildTime = (messages: () => Message[]) => median(Array.from({ length: 7 }, () => {
  const loaded = messages()
  const start = performance.now()
  conversation(loaded, true).dispose()
  return performance.now() - start
}))

for (const size of [1_000, 5_000]) {
  const label = size.toLocaleString()
  recorded(`streamed chunk, ${label}-message transcript`, 'ms / chunk', perStep(size, 200, streamToken))
  recorded(`new tool call, ${label}-message transcript`, 'ms / message', perStep(size, 100, appendTool))
  recorded(`first build (tab mount), ${label} messages`, 'ms', buildTime(() => session(size)))
}

// ---------------------------------------------------------------------------
// first page: what opening a conversation reads and builds
// ---------------------------------------------------------------------------

function claudeLine(type: 'user' | 'assistant', text: string, timestamp: number): string {
  return JSON.stringify({ type, timestamp: new Date(timestamp).toISOString(), message: { content: [{ type: 'text', text }] } }) + '\n'
}

const pageDirectory = await mkdtemp(join(tmpdir(), 'solus-bench-pages-'))
for (const [shape, stepsPerTurn] of [['quiet', 2], ['typical', 8], ['busy', 40]] as const) {
  const file = join(pageDirectory, `${shape}.jsonl`)
  let body = ''
  let at = 1_700_000_000_000
  for (let turn = 0; turn < 300; turn++) {
    body += claudeLine('user', `Prompt ${turn}: fix the next failing case.`, at++)
    for (let step = 0; step < stepsPerTurn; step++) body += claudeLine('assistant', `${prose} ${turn}.${step}`, at++)
  }
  await writeFile(file, body)
  const page = (await loadClaudeHistoryPage(file, INITIAL_HISTORY_TURNS)).messages
  const toMessages = (rows: SessionLoadMessage[]): Message[] => rows.map((row, index) =>
    ({ id: `p${index}`, role: row.role === 'user' ? 'user' : 'assistant', content: row.content, timestamp: row.timestamp }))
  recorded(`first page, ${shape} session (${stepsPerTurn} steps a turn)`, 'messages', page.length,
    `${page.filter((row) => row.role === 'user').length} turns`)
  recorded(`first page wire size, ${shape} session`, 'KB', JSON.stringify(page).length / 1024)
  recorded(`first page build, ${shape} session`, 'ms', buildTime(() => toMessages(page)))
}
await rm(pageDirectory, { recursive: true, force: true })

// The same first page as the host sends it for a busy session of real tool
// rows (40 tools a turn, Edit bodies and Read outputs of 3.7 KB): results are
// projected either way; the change is deferring the inputs on every client
// instead of only on a phone.
{
  const body = 'export const value = compute(input);\n'.repeat(100)
  const page: SessionLoadMessage[] = []
  let at = 0
  for (let turn = 0; turn < INITIAL_HISTORY_TURNS; turn++) {
    page.push({ role: 'user', content: `Prompt ${turn}`, timestamp: ++at })
    for (let step = 0; step < 40; step++) {
      const toolId = `tool-${turn}-${step}`
      const filePath = `/repo/src/file-${step}.ts`
      page.push({ role: 'tool', toolId, toolName: step % 2 ? 'Edit' : 'Read', content: '', timestamp: ++at,
        toolInput: JSON.stringify(step % 2 ? { file_path: filePath, old_string: body, new_string: body } : { file_path: filePath }) })
      page.push({ role: 'tool_result', toolResultForId: toolId, content: body, timestamp: ++at })
    }
    page.push({ role: 'assistant', content: 'Done. '.repeat(40), timestamp: ++at })
  }
  const projected = projectSessionHistory(page)
  results.push({
    name: 'first page wire, busy session of tool rows (10 turns × 40 tools)', unit: 'KB',
    before: JSON.stringify(projected).length / 1024,
    after: JSON.stringify(deferSessionToolInputs(projected)).length / 1024,
    note: 'before: inputs deferred on phones only',
  })
}

// ---------------------------------------------------------------------------
// memory and mounted views: 20 tabs, each once scrolled back to 2,000 messages
// ---------------------------------------------------------------------------

function heapMb(): number {
  Bun.gc(true)
  return heapSize() / 1024 / 1024
}

{
  const TABS = 20
  // A typical first page: ten turns of nine messages.
  const RESTORED = INITIAL_HISTORY_TURNS * 9
  const EXPANDED = 2_000
  const open = Array.from({ length: TABS }, (_, index) => `tab-${index}`)
  let mounted: string[] = []
  for (const tabId of open) mounted = mountedConversationTabIds(mounted, tabId, open, true)

  const measure = (keep: (tabIndex: number) => number) => {
    const base = heapMb()
    const held = open.map((_, index) => reactive(session(EXPANDED).slice(-keep(index))))
    const used = heapMb() - base
    void held.length
    return used
  }
  results.push({
    name: `transcript data held, ${TABS} tabs each scrolled to ${EXPANDED.toLocaleString()} messages`, unit: 'MB heap',
    // Before: every visited tab kept every page it had loaded.
    before: measure(() => EXPANDED),
    // After: tabs outside the pool drop back to their first page.
    after: measure((index) => mounted.includes(open[index]) ? EXPANDED : RESTORED),
    note: `${MAX_MOUNTED_CONVERSATIONS} mounted keep their history; others keep ${RESTORED}`,
  })
  results.push({
    name: `conversation views mounted after visiting ${TABS} tabs`, unit: 'views',
    before: TABS, after: mounted.length, note: 'each view: DOM, effects, observers, orb, cards',
  })
}

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------

console.table(results.map((result) => ({
  Benchmark: result.name,
  Unit: result.unit,
  Before: result.before.toFixed(result.before < 10 ? 3 : 1),
  After: result.after.toFixed(result.after < 10 ? 3 : 1),
  Change: result.before > 0 ? `${(((result.after - result.before) / result.before) * 100).toFixed(1)}%` : '',
  Note: result.note ?? '',
})))
const outPath = join(new URL('.', import.meta.url).pathname, 'transcript-results.json')
writeFileSync(outPath, JSON.stringify(results, null, 2))
console.log('Wrote', outPath)
runes.dispose()

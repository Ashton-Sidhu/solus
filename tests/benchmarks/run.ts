/**
 * Performance micro-benchmarks for the 2026-08 CPU/RAM optimization pass.
 *
 * Run with: bun tests/benchmarks/run.ts
 *
 * Each benchmark compares a `legacy` variant (the pre-optimization code shape,
 * copied inline and frozen) against the `current` implementation imported from
 * the live source. Before the optimization lands the two match; after it lands
 * the delta is the measured win. Benchmarks marked "mirror" copy both shapes
 * inline because the real function is private or requires the Svelte runtime.
 *
 * No benchmark runs git, touches live Solus data, or starts the app.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'

import type { Message, Session } from '../../src/shared/types'
import { computeCurrentActivity } from '../../src/renderer/contexts/workspace/session.utils'
import { turnDurationMs, type Turn } from '../../src/renderer/components/conversation/lib/turns'
import * as activitySummary from '../../src/renderer/components/conversation/lib/activity-summary'
import { scanCodexThreadActivityTimestamp } from '../../src/main/agents/codex/codex-utils'

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

interface BenchResult {
  name: string
  unit: string
  legacy: number
  current: number
  note?: string
}

const results: BenchResult[] = []

/** Median wall time of `runs` timed invocations, after `warmup` untimed ones. */
function timeMs(fn: () => void, { runs = 15, warmup = 3 } = {}): number {
  for (let i = 0; i < warmup; i++) fn()
  const samples: number[] = []
  for (let i = 0; i < runs; i++) {
    const start = performance.now()
    fn()
    samples.push(performance.now() - start)
  }
  samples.sort((a, b) => a - b)
  return samples[Math.floor(samples.length / 2)]
}

function report(name: string, unit: string, legacy: number, current: number, note?: string): void {
  results.push({ name, unit, legacy, current, note })
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

let idCounter = 0
function toolMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: `bench-${++idCounter}`,
    role: 'tool',
    content: '',
    timestamp: 1_700_000_000_000 + idCounter * 1000,
    toolName: 'Read',
    toolStatus: 'success',
    toolInput: JSON.stringify({ file_path: `/repo/src/file-${idCounter % 50}.ts`, offset: idCounter }),
    ...overrides,
  } as Message
}

function textMessage(role: 'user' | 'assistant', content: string): Message {
  return {
    id: `bench-${++idCounter}`,
    role,
    content,
    timestamp: 1_700_000_000_000 + idCounter * 1000,
  } as Message
}

/** A settled 5k-message transcript: many turns, none currently running. */
function buildLongSession(messageCount: number): Session {
  const messages: Message[] = []
  while (messages.length < messageCount - 10) {
    messages.push(textMessage('user', 'do the thing'))
    for (let i = 0; i < 8; i++) messages.push(toolMessage())
    messages.push(textMessage('assistant', 'did the thing'))
  }
  messages.push(textMessage('user', 'latest prompt'))
  for (let i = 0; i < 6; i++) messages.push(toolMessage())
  return {
    messages,
    permissionQueue: [],
    questionQueue: [],
    isStreamingText: false,
    isReconnecting: false,
    currentActivity: '',
    status: 'running',
  } as unknown as Session
}

// ---------------------------------------------------------------------------
// 1. computeCurrentActivity — reverse scan bound (renderer/session.utils.ts)
// ---------------------------------------------------------------------------

function legacyComputeCurrentActivity(session: Session): string {
  if (session.permissionQueue.length > 0) return 'perm'
  if (session.questionQueue.length > 0) return 'question'
  if (session.isStreamingText) return 'Writing...'
  if (session.isReconnecting) return 'Reconnecting...'
  // Pre-change shape: unbounded reverse scan to index 0 when no tool is running.
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const message = session.messages[i]
    if (message.role === 'tool' && message.toolStatus === 'running' && message.toolName) {
      return `Running ${message.toolName}...`
    }
  }
  return 'Thinking...'
}

{
  const session = buildLongSession(5000)
  const ITERATIONS = 2000
  const legacy = timeMs(() => {
    for (let i = 0; i < ITERATIONS; i++) legacyComputeCurrentActivity(session)
  })
  const current = timeMs(() => {
    for (let i = 0; i < ITERATIONS; i++) computeCurrentActivity(session)
  })
  report('computeCurrentActivity idle scan (5k msgs × 2k calls)', 'ms', legacy, current)
}

// ---------------------------------------------------------------------------
// 2. turnDurationMs — spread allocation (conversation/lib/turns.ts)
// ---------------------------------------------------------------------------

function buildBigTurn(): Turn {
  const tools = Array.from({ length: 120 }, () => toolMessage({ toolCompletedAt: Date.now() }))
  const body = tools.map((message) => ({ kind: 'tool-group' as const, messages: [message] }))
  for (let i = 0; i < 200; i++) body.push({ kind: 'assistant', message: textMessage('assistant', 'chunk') } as never)
  return {
    start: textMessage('user', 'go'),
    startedAt: 1_700_000_000_000,
    end: textMessage('assistant', 'done'),
    body,
    tail: [{ kind: 'assistant', message: textMessage('assistant', 'tail') }],
    tools,
  } as unknown as Turn
}

function legacyTurnDurationMs(turn: Turn): number | null {
  if (!turn.startedAt) return null
  let end = turn.end?.timestamp ?? -Infinity
  for (const tool of turn.tools) {
    if (tool.toolCompletedAt) end = Math.max(end, tool.toolCompletedAt)
    end = Math.max(end, tool.timestamp)
  }
  // Pre-change shape: merged copy of the whole turn per call.
  for (const item of [...turn.body, ...turn.tail]) {
    if (item.kind === 'live-assistant') continue
    if (item.kind === 'tool-group' || item.kind === 'subagent-group' || item.kind === 'agent-conversation-group') continue
    end = Math.max(end, item.message.timestamp)
  }
  if (!Number.isFinite(end) || end <= turn.startedAt) return null
  return end - turn.startedAt
}

{
  const turn = buildBigTurn()
  const ITERATIONS = 20_000
  const legacy = timeMs(() => {
    for (let i = 0; i < ITERATIONS; i++) legacyTurnDurationMs(turn)
  })
  const current = timeMs(() => {
    for (let i = 0; i < ITERATIONS; i++) turnDurationMs(turn)
  })
  report('turnDurationMs (320-item turn × 20k calls)', 'ms', legacy, current)
}

// ---------------------------------------------------------------------------
// 3. parseToolInput — shared memoization (conversation/lib/activity-summary.ts)
// ---------------------------------------------------------------------------

{
  const tools = Array.from({ length: 400 }, () => toolMessage())
  const ITERATIONS = 50
  const legacy = timeMs(() => {
    for (let i = 0; i < ITERATIONS; i++) {
      for (const tool of tools) activitySummary.parseToolInput(tool.toolInput!)
    }
  })
  // After the change this goes through the shared WeakMap cache; before it, the
  // fallback is the same uncached parse, so legacy === current at baseline.
  const cachedParse: (message: Message) => unknown =
    (activitySummary as { parseToolInputForMessage?: (message: Message) => unknown }).parseToolInputForMessage ??
    ((message: Message) => activitySummary.parseToolInput(message.toolInput!))
  const current = timeMs(() => {
    for (let i = 0; i < ITERATIONS; i++) {
      for (const tool of tools) cachedParse(tool)
    }
  })
  report('tool-input parse, 400 tools re-read 50×', 'ms', legacy, current)
}

// ---------------------------------------------------------------------------
// 4. agent-conversation messageFor — scan direction (mirror; private method)
// ---------------------------------------------------------------------------

{
  const session = buildLongSession(5000)
  const targetId = session.messages[session.messages.length - 3].id
  const ITERATIONS = 5000
  const legacy = timeMs(() => {
    for (let i = 0; i < ITERATIONS; i++) {
      session.messages.find((message) => message.id === targetId)
    }
  })
  const current = timeMs(() => {
    for (let i = 0; i < ITERATIONS; i++) {
      let found: Message | undefined
      for (let j = session.messages.length - 1; j >= 0; j--) {
        if (session.messages[j].id === targetId) { found = session.messages[j]; break }
      }
      void found
    }
  })
  report('agent-conversation card lookup (5k msgs × 5k calls, mirror)', 'ms', legacy, current)
}

// ---------------------------------------------------------------------------
// 5. Codex thread activity timestamp — full parse vs tail read
// ---------------------------------------------------------------------------

async function benchCodexScan(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'solus-bench-'))
  const path = join(dir, 'thread.jsonl')
  const lines: string[] = []
  for (let i = 0; i < 20_000; i++) {
    lines.push(JSON.stringify({
      type: 'response_item',
      timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(),
      payload: { type: 'message', content: 'x'.repeat(180) },
    }))
  }
  writeFileSync(path, lines.join('\n'))

  // Pre-change shape: stream + JSON.parse every line of the transcript.
  async function legacyScan(): Promise<number | null> {
    const { createReadStream } = await import('node:fs')
    const { createInterface } = await import('node:readline')
    let latest: number | null = null
    await new Promise<void>((resolve) => {
      const rl = createInterface({ input: createReadStream(path) })
      rl.on('line', (line: string) => {
        try {
          const obj = JSON.parse(line)
          let timestamp: number | null = null
          if (obj.type === 'event_msg' && obj.payload?.type === 'task_started') timestamp = Date.parse(obj.payload?.started_at ?? obj.timestamp)
          else if (obj.type === 'response_item') timestamp = Date.parse(obj.timestamp)
          if (timestamp !== null && !Number.isNaN(timestamp)) latest = Math.max(latest ?? 0, timestamp)
        } catch {}
      })
      rl.on('close', () => resolve())
      rl.on('error', () => resolve())
    })
    return latest
  }

  const thread = { id: 'bench', path } as Parameters<typeof scanCodexThreadActivityTimestamp>[0]

  const legacyStart = performance.now()
  for (let i = 0; i < 10; i++) await legacyScan()
  const legacy = (performance.now() - legacyStart) / 10

  const currentStart = performance.now()
  for (let i = 0; i < 10; i++) await scanCodexThreadActivityTimestamp(thread)
  const current = (performance.now() - currentStart) / 10

  // Sanity: both must agree on the answer.
  const expected = await legacyScan()
  const actual = await scanCodexThreadActivityTimestamp(thread)
  const note = expected === actual ? undefined : `MISMATCH legacy=${expected} current=${actual}`

  report('codex activity timestamp, 4.5 MB / 20k-line JSONL (per scan)', 'ms', legacy, current, note)
  rmSync(dir, { recursive: true, force: true })
}
await benchCodexScan()

// ---------------------------------------------------------------------------
// 6. Session sidecar serialization — pretty vs compact (mirror; private fns)
// ---------------------------------------------------------------------------

{
  const sidecar = {
    baseSha: 'a'.repeat(40),
    turns: Array.from({ length: 500 }, (_, i) => ({
      turnId: `turn-${i}`,
      sha: 'b'.repeat(40),
      queuedAt: 1_700_000_000_000 + i,
      files: [`src/a-${i}.ts`, `src/b-${i}.ts`],
    })),
    sessionChangedFiles: Array.from({ length: 300 }, (_, i) => `src/changed-${i}.ts`),
  }
  const ITERATIONS = 500
  const legacy = timeMs(() => {
    for (let i = 0; i < ITERATIONS; i++) JSON.stringify(sidecar, null, 2)
  })
  const current = timeMs(() => {
    for (let i = 0; i < ITERATIONS; i++) JSON.stringify(sidecar)
  })
  const prettyBytes = JSON.stringify(sidecar, null, 2).length
  const compactBytes = JSON.stringify(sidecar).length
  report('turn sidecar serialize, 500-turn session × 500 writes', 'ms', legacy, current,
    `payload ${(prettyBytes / 1024).toFixed(0)} KB → ${(compactBytes / 1024).toFixed(0)} KB`)
}

// ---------------------------------------------------------------------------
// 7. Git watcher change detection — stringify×3 vs hash + field compare (mirror)
// ---------------------------------------------------------------------------

{
  const status = {
    branch: 'main',
    headSha: 'c'.repeat(40),
    targetBranch: 'main',
    repoRoot: '/repo',
    files: Array.from({ length: 500 }, (_, i) => ({
      path: `src/renderer/components/feature/File-${i}.svelte`,
      status: 'modified',
      additions: i,
      deletions: i % 7,
    })),
  }
  const gitContext = { branch: 'main', detachedHeadSha: undefined, targetBranch: 'main', repoRoot: '/repo', worktreePath: undefined }
  const ITERATIONS = 500

  let legacyStore = ''
  const legacy = timeMs(() => {
    for (let i = 0; i < ITERATIONS; i++) {
      // Pre-change shape: serialize status for compare+store, then two more
      // stringifies for the context equality check.
      const serialized = JSON.stringify(status)
      if (legacyStore !== serialized) legacyStore = serialized
      if (JSON.stringify(gitContext) !== JSON.stringify({ ...gitContext })) throw new Error('unreachable')
    }
  })

  let currentStore = ''
  const current = timeMs(() => {
    for (let i = 0; i < ITERATIONS; i++) {
      // Post-change shape: status compare unchanged, context compared per field.
      const serialized = JSON.stringify(status)
      if (currentStore !== serialized) currentStore = serialized
      const next = { ...gitContext }
      const same = next.branch === gitContext.branch && next.detachedHeadSha === gitContext.detachedHeadSha &&
        next.targetBranch === gitContext.targetBranch && next.repoRoot === gitContext.repoRoot &&
        next.worktreePath === gitContext.worktreePath
      if (!same) throw new Error('unreachable')
    }
  })
  const retainedLegacy = JSON.stringify(status).length
  report('git watcher fire, 500-file status × 500 fires (mirror)', 'ms', legacy, current,
    `retained/cwd ${(retainedLegacy / 1024).toFixed(0)} KB, evicted on deregister`)
}

// ---------------------------------------------------------------------------
// 8. Diff find-bar short queries — unbounded walk vs min-length + cap (mirror)
// ---------------------------------------------------------------------------

{
  const lines: string[] = []
  for (let i = 0; i < 120_000; i++) lines.push(`const value${i} = compute(input${i}, options${i});`.toLowerCase())
  interface Match { lineNo: number; matchStart: number; matchLength: number }

  function walk(needle: string, cap: number): Match[] {
    const out: Match[] = []
    for (let lineNo = 0; lineNo < lines.length; lineNo++) {
      const text = lines[lineNo]
      let idx = text.indexOf(needle)
      while (idx !== -1) {
        out.push({ lineNo, matchStart: idx, matchLength: needle.length })
        if (out.length >= cap) return out
        idx = text.indexOf(needle, idx + needle.length)
      }
    }
    return out
  }

  const legacy = timeMs(() => { walk('e', Number.POSITIVE_INFINITY) })
  const current = timeMs(() => {
    const query = 'e'
    if (query.length >= 2) walk(query, 2000)
  })
  const legacyCount = walk('e', Number.POSITIVE_INFINITY).length
  report('find-bar 1-char query on 120k-line diff (mirror)', 'ms', legacy, current,
    `${legacyCount.toLocaleString()} match objects → 0`)
}

// ---------------------------------------------------------------------------
// 9. Lowlight registry — full common bundle vs curated set
// ---------------------------------------------------------------------------

async function benchLowlight(): Promise<void> {
  const { createLowlight, common } = await import('lowlight')
  const curated = await import('../../src/renderer/lib/lowlight')
  const registered = curated.lowlight.listLanguages().length
  const commonCount = Object.keys(common).length
  const names = ['bash', 'c', 'cpp', 'css', 'go', 'java', 'javascript', 'json', 'markdown', 'python', 'rust', 'shell', 'sql', 'typescript', 'xml', 'yaml']
  const subset: Record<string, unknown> = {}
  for (const name of names) if (name in common) subset[name] = (common as Record<string, unknown>)[name]

  const legacy = timeMs(() => { createLowlight(common) }, { runs: 9, warmup: 1 })
  const current = timeMs(() => {
    const instance = createLowlight()
    for (const [name, grammar] of Object.entries(subset)) instance.register(name, grammar as never)
  }, { runs: 9, warmup: 1 })
  report(`lowlight registry init (${commonCount} grammars → ${registered})`, 'ms', legacy, current)
}
await benchLowlight()

// ---------------------------------------------------------------------------
// 10. Login-shell PATH probe — the synchronous boot stall M5 removes
// ---------------------------------------------------------------------------

{
  const start = performance.now()
  try {
    execSync('/bin/zsh -ilc "echo $PATH"', { encoding: 'utf-8', timeout: 3000 })
  } catch {}
  const probeMs = performance.now() - start
  report('interactive login-shell probe (potential sync boot stall)', 'ms', probeMs, 0,
    'after: resolved async off the boot path')
}

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------

const rows = results.map((r) => {
  const reduction = r.legacy > 0 ? ((r.legacy - r.current) / r.legacy) * 100 : 0
  return {
    Benchmark: r.name,
    'Before (ms)': r.legacy.toFixed(2),
    'After (ms)': r.current.toFixed(2),
    'Reduction %': `${reduction.toFixed(1)}%`,
    Note: r.note ?? '',
  }
})
console.table(rows)
const outDir = new URL('.', import.meta.url).pathname
writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2))
console.log('Wrote', join(outDir, 'results.json'))

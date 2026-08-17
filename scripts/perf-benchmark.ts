/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-chained-type-assertions, anti-slop/no-unsafe-dictionary-type -- benchmark fixtures assert minimal shapes on purpose; only fields the measured paths read are populated */
/**
 * Before/after micro-benchmarks for the 2026-08 perceived-lag optimization pass.
 *
 * Each case pits the pre-change algorithm (inlined verbatim from the old
 * source) against the shipped implementation on the same representative data.
 * Run with: bun scripts/perf-benchmark.ts
 *
 * DOM-bound changes from the same pass (PillLayout pool retention, rAF
 * coalescing in OuterScrollbar/DiffStream) are structural and cannot be
 * measured in a headless bun process; they are reported separately.
 */
import { inspect } from 'node:util'
import { z } from 'zod'
import { estimateRetainedBytes } from '../src/main/transports/response-receipt-cache'
import { parseToolInput } from '../src/renderer/components/conversation/lib/activity-summary'
import { parseSubagentInput } from '../src/renderer/components/conversation/lib/subagent'
import { buildTurns, groupMessages, stabilizeTurns } from '../src/renderer/components/conversation/lib/turns'
import { dedupeHistoryEntries, FrozenEntryOrder } from '../src/renderer/lib/pickerEntries'
import type { Message, Session, SessionMeta, Tab } from '../src/shared/types'

interface BenchResult {
  name: string
  beforeMs: number
  afterMs: number
  unit: string
}

const results: BenchResult[] = []

function bench(_label: string, iterations: number, fn: () => void): number {
  // Warmup for JIT stability, then take the best of 5 timed runs.
  for (let i = 0; i < Math.max(1, Math.ceil(iterations / 5)); i++) fn()
  let best = Number.POSITIVE_INFINITY
  for (let run = 0; run < 5; run++) {
    const start = performance.now()
    for (let i = 0; i < iterations; i++) fn()
    best = Math.min(best, performance.now() - start)
  }
  return best
}

function record(name: string, unit: string, beforeMs: number, afterMs: number): void {
  results.push({ name, beforeMs, afterMs, unit })
  const reduction = ((1 - afterMs / beforeMs) * 100).toFixed(1)
  console.log(`${name}\n  before ${beforeMs.toFixed(2)}ms  after ${afterMs.toFixed(2)}ms  (${reduction}% less, ${unit})\n`)
}

// ───────────────────────────────────────────────────────────────────────────
// Shared fixtures
// ───────────────────────────────────────────────────────────────────────────

/** A settled loadSession-like payload: 200 messages with tool bodies. */
function sessionPayload(messageCount = 200): object[] {
  const messages: object[] = []
  for (let i = 0; i < messageCount; i++) {
    messages.push({
      id: `m${i}`,
      role: i % 3 === 0 ? 'user' : i % 3 === 1 ? 'assistant' : 'tool',
      content: 'line of prose '.repeat(120),
      timestamp: 1_755_000_000_000 + i,
      toolName: i % 3 === 2 ? 'Read' : undefined,
      toolInput: i % 3 === 2 ? JSON.stringify({ file_path: `/repo/src/file-${i}.ts` }) : undefined,
      toolResult: i % 3 === 2 ? { content: 'tool output '.repeat(400), isError: false } : undefined,
      meta: { tokens: i * 17, model: 'claude-sonnet-5', flags: [true, false, i % 2 === 0] },
    })
  }
  return messages
}

// ───────────────────────────────────────────────────────────────────────────
// 1. estimateRetainedBytes — zod-per-node dispatch vs typeof walk
//    (src/main/transports/response-receipt-cache.ts, runs per settled RPC)
// ───────────────────────────────────────────────────────────────────────────
{
  // Verbatim pre-change implementation.
  function estimateRetainedBytesZod<Value>(value: Value, ceiling = Number.POSITIVE_INFINITY): number {
    const seen = new WeakSet<object>()
    let bytes = 0
    const visit = <Candidate,>(candidate: Candidate): void => {
      if (bytes > ceiling || candidate == null) return
      const stringCandidate = z.string().safeParse(candidate)
      if (stringCandidate.success) {
        bytes += 16 + stringCandidate.data.length * 2
        return
      }
      if (z.union([z.number(), z.bigint()]).safeParse(candidate).success) {
        bytes += 8
        return
      }
      if (z.boolean().safeParse(candidate).success) {
        bytes += 4
        return
      }
      const objectCandidate = z.object({}).passthrough().safeParse(candidate)
      if (!objectCandidate.success || seen.has(objectCandidate.data)) return
      seen.add(objectCandidate.data)
      bytes += 48
      if (ArrayBuffer.isView(candidate)) {
        bytes += candidate.byteLength
        return
      }
      if (candidate instanceof ArrayBuffer) {
        bytes += candidate.byteLength
        return
      }
      if (Array.isArray(candidate)) {
        bytes += candidate.length * 8
        for (const item of candidate) {
          visit(item)
          if (bytes > ceiling) break
        }
        return
      }
      for (const [key, item] of Object.entries(objectCandidate.data)) {
        bytes += 8 + key.length * 2
        visit(item)
        if (bytes > ceiling) break
      }
    }
    try {
      visit(value)
    } catch {
      return ceiling + 1
    }
    return bytes
  }

  // Array-free payload so both versions walk the same nodes: the zod version
  // silently rejected arrays (z.object() fails on them), counting an entire
  // message array as 0 bytes — a budget-accounting bug the rewrite also fixes.
  // On array-heavy payloads the old code was "fast" only by skipping the work.
  const entries: Record<string, object> = {}
  for (let i = 0; i < 500; i++) {
    entries[`session-${i}`] = {
      id: `session-${i}`,
      title: 'refactor pass '.repeat(8),
      active: i % 2 === 0,
      tokens: i * 13,
      run: { provider: 'claude-code', cwd: `/repo/wt-${i}`, meta: { model: 'claude-fable-5', effort: 'high' } },
    }
  }
  const payload = { version: 1, entries }
  const before = bench('estimate/zod', 50, () => estimateRetainedBytesZod(payload))
  const after = bench('estimate/typeof', 50, () => estimateRetainedBytes(payload))
  record(
    'estimateRetainedBytes on a 500-entry settled RPC payload',
    '50 settlements',
    before,
    after,
  )
}

// ───────────────────────────────────────────────────────────────────────────
// 2. loadSession debug byte accounting — double vs single serialization
//    (src/main/server/handlers/history-handlers.ts)
// ───────────────────────────────────────────────────────────────────────────
{
  const messages = sessionPayload(400)
  const serializedBytes = <T,>(value: T): number => Buffer.byteLength(JSON.stringify(value))
  const before = bench('history/double', 10, () => {
    let total = serializedBytes(messages) // whole-transcript stringify (old first log line)
    for (const message of messages) total += serializedBytes(message)
    if (total === -1) throw new Error('unreachable')
  })
  const after = bench('history/single', 10, () => {
    let total = 0
    for (const message of messages) total += serializedBytes(message)
    if (total === -1) throw new Error('unreachable')
  })
  record('loadSession debug byte accounting (400 messages)', '10 session loads', before, after)
}

// ───────────────────────────────────────────────────────────────────────────
// 3. Dev console formatter — unbounded vs capped inspect
//    (src/main/logger.ts formatDevData, runs on every dev log call)
// ───────────────────────────────────────────────────────────────────────────
{
  const entry = {
    sessionId: 's1',
    toolResult: 'x'.repeat(400_000),
    items: Array.from({ length: 5_000 }, (_, i) => ({ index: i, path: `/repo/file-${i}.ts` })),
  }
  const before = bench('inspect/unbounded', 5, () =>
    inspect(entry, { colors: true, compact: false, depth: null, maxArrayLength: null, maxStringLength: null, breakLength: 120 }),
  )
  const after = bench('inspect/capped', 5, () =>
    inspect(entry, { colors: true, compact: false, depth: 8, maxArrayLength: 100, maxStringLength: 2000, breakLength: 120 }),
  )
  record('formatDevData on a large log payload', '5 log calls', before, after)
}

// ───────────────────────────────────────────────────────────────────────────
// 4. Codex stdout line splitting — quadratic slicing vs cursor scan
//    (src/main/agents/codex/codex-agent.ts onStdout)
// ───────────────────────────────────────────────────────────────────────────
{
  // One 8 MB JSON-RPC frame arriving in 64 KiB chunks, then a trailing burst of
  // small lines — the shape of a large tool result during streaming.
  const bigFrame = `${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: 'y'.repeat(8 * 1024 * 1024) } })}\n`
  const chunks: string[] = []
  for (let i = 0; i < bigFrame.length; i += 64 * 1024) chunks.push(bigFrame.slice(i, i + 64 * 1024))
  for (let i = 0; i < 50; i++) chunks.push(`${JSON.stringify({ jsonrpc: '2.0', method: 'tick', params: { i } })}\n`)

  let consumed = 0
  const onLine = (line: string) => {
    consumed += line.length
  }

  const before = bench('stdout/slice', 1, () => {
    let buffer = ''
    for (const chunk of chunks) {
      buffer += chunk
      for (;;) {
        const idx = buffer.indexOf('\n')
        if (idx === -1) break
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (line) onLine(line)
      }
    }
  })
  // Shipped implementation: the retained tail never holds a newline, so only
  // the appended chunk is scanned — O(n) total instead of re-scanning the
  // accumulated buffer on every chunk.
  const after = bench('stdout/cursor', 1, () => {
    let buffer = ''
    for (const chunk of chunks) {
      const data = buffer ? buffer + chunk : chunk
      const lines: string[] = []
      let cursor = 0
      let idx = data.indexOf('\n', buffer.length)
      while (idx !== -1) {
        const line = data.slice(cursor, idx).trim()
        cursor = idx + 1
        if (line) lines.push(line)
        idx = data.indexOf('\n', cursor)
      }
      buffer = cursor === 0 ? data : data.slice(cursor)
      for (const line of lines) onLine(line)
    }
  })
  if (consumed === 0) throw new Error('benchmark consumed nothing')
  record('Codex stdout buffering of an 8 MB frame in 64 KiB chunks', '1 frame', before, after)
}

// Note: a chunk-array rewrite of control-plane pendingFlush was prototyped and
// measured HERE to be slower than the existing `+=` (engine rope strings make
// unread concatenation O(1) per token), so that change was reverted. The
// accumulation stays a plain string on purpose.

// ───────────────────────────────────────────────────────────────────────────
// 6. gitContext change detection — double JSON.stringify vs field compare
//    (src/main/control-plane.ts watcher path, per session per watcher fire)
// ───────────────────────────────────────────────────────────────────────────
{
  const gitContext = {
    branch: 'solus/perf-pass',
    detachedHeadSha: undefined as string | undefined,
    targetBranch: 'main',
    repoRoot: '/Users/dev/solus',
    provider: 'github',
    remoteUrl: 'git@github.com:solus/solus.git',
  }
  const next = { ...gitContext }
  const before = bench('git/stringify', 100_000, () => {
    if (JSON.stringify(next) !== JSON.stringify(gitContext)) throw new Error('unreachable')
  })
  const after = bench('git/fields', 100_000, () => {
    const changed =
      next.branch !== gitContext.branch ||
      next.detachedHeadSha !== gitContext.detachedHeadSha ||
      next.targetBranch !== gitContext.targetBranch ||
      next.repoRoot !== gitContext.repoRoot
    if (changed) throw new Error('unreachable')
  })
  record('gitContext change detection', '100k watcher comparisons', before, after)
}

// ───────────────────────────────────────────────────────────────────────────
// 7. Tool-input parsing under clock ticks — per-call parse vs memo cache
//    (activity-summary.ts parseToolInput + subagent.ts parseSubagentInput)
// ───────────────────────────────────────────────────────────────────────────
{
  // 8 running sub-agents × 100 tool calls; headers/rows re-derive once per
  // second per surface (~4 reads per message per tick in SubagentGroup alone).
  const inputs = Array.from({ length: 800 }, (_, i) =>
    JSON.stringify({ file_path: `/repo/src/feature/file-${i}.ts`, description: `step ${i}`, prompt: 'p'.repeat(200) }),
  )
  const toolPathSchema = z.object({
    file_path: z.string().optional(), path: z.string().optional(), file: z.string().optional(),
    fileName: z.string().optional(), filename: z.string().optional(), old_path: z.string().optional(),
    new_path: z.string().optional(), oldPath: z.string().optional(), newPath: z.string().optional(),
  })
  const toolInputSchema = toolPathSchema.extend({
    changes: z.array(toolPathSchema).optional(), pattern: z.string().optional(), command: z.string().optional(),
    query: z.string().optional(), search_query: z.string().optional(), url: z.string().optional(),
    prompt: z.string().optional(), description: z.string().optional(), skill: z.string().optional(),
  })
  const parseUncached = (value: string) => {
    try {
      const result = toolInputSchema.safeParse(JSON.parse(value))
      return result.success ? { ...result.data, sourceJson: value } : null
    } catch {
      return null
    }
  }
  // 30 ticks of a live fan-out: every surface re-reads every input each tick.
  const before = bench('parse/uncached', 30, () => {
    for (const input of inputs) parseUncached(input)
  })
  const after = bench('parse/cached', 30, () => {
    for (const input of inputs) parseToolInput(input)
  })
  record('tool-input parsing, 800 inputs re-read over 30 ticks', '30 ticks', before, after)

  const subagentInputs = Array.from({ length: 8 }, (_, i) =>
    JSON.stringify({ subagent_type: 'Explore', description: `audit region ${i}`, prompt: 'q'.repeat(2000) }),
  )
  const subBefore = bench('subparse/uncached', 2_000, () => {
    for (const input of subagentInputs) {
      try {
        JSON.parse(input)
      } catch {
        /* mirror old failure path */
      }
    }
  })
  const subAfter = bench('subparse/cached', 2_000, () => {
    for (const input of subagentInputs) parseSubagentInput(input)
  })
  record('subagent-input parsing, 8 agents re-read over 2k ticks', '2k ticks', subBefore, subAfter)
}

// ───────────────────────────────────────────────────────────────────────────
// 8. Streaming reveal frame — full Turn churn vs stabilized identities
//    (turns.ts stabilizeTurns + ConversationView reveal ticker)
// ───────────────────────────────────────────────────────────────────────────
{
  let clock = 0
  const msg = (partial: Partial<Message> & Pick<Message, 'role'>): Message => {
    clock += 1000
    return { id: `m${clock}`, content: 'answer text', timestamp: clock, ...partial } as Message
  }
  const transcript: Message[] = []
  for (let i = 0; i < 50; i++) {
    transcript.push(msg({ role: 'user', content: `prompt ${i}` }))
    transcript.push(msg({ role: 'tool', toolName: 'Read', toolInput: '{"file_path":"a.ts"}', toolStatus: 'completed' }))
    transcript.push(msg({ role: 'assistant', content: `answer ${i}` }))
  }
  const grouped = groupMessages(transcript)

  // What each reveal frame costs is buildTurns either way; what stabilization
  // changes is how many Turn identities survive. Fresh identities are what
  // re-run every row component's derived state downstream.
  let previous = buildTurns(
    [...grouped, { kind: 'live-assistant' as const, id: 'live-stream', content: 'st' }],
    { running: true },
  )
  let churnedIdentities = 0
  const frames = 300 // ten seconds of streaming at 30 fps
  for (let frame = 0; frame < frames; frame++) {
    const next = stabilizeTurns(
      buildTurns(
        [...grouped, { kind: 'live-assistant' as const, id: 'live-stream', content: 'st'.repeat(frame + 2) }],
        { running: true },
      ),
      previous,
    )
    for (let i = 0; i < next.length; i++) if (next[i] !== previous[i]) churnedIdentities++
    previous = next
  }
  const turnCount = previous.length
  const beforeChurn = frames * turnCount // every turn object was fresh every frame
  console.log(
    `Turn identity churn over ${frames} reveal frames (${turnCount}-turn transcript)\n` +
      `  before ${beforeChurn} fresh identities  after ${churnedIdentities}  ` +
      `(${((1 - churnedIdentities / beforeChurn) * 100).toFixed(1)}% less downstream derived re-runs)\n`,
  )
  results.push({
    name: 'Turn identity churn during streaming (downstream derived re-runs)',
    beforeMs: beforeChurn,
    afterMs: churnedIdentities,
    unit: 'identities over 300 frames',
  })
}

// ───────────────────────────────────────────────────────────────────────────
// 9. Session picker — dedupe scan and frozen-order sort
//    (src/renderer/lib/pickerEntries.ts)
// ───────────────────────────────────────────────────────────────────────────
{
  const historySessions: SessionMeta[] = Array.from({ length: 3000 }, (_, i): SessionMeta => ({
    sessionId: `hist-${i}`,
    provider: 'claude-code',
    slug: `session-${i}`,
    firstMessage: `prompt ${i % 2500}`, // some worktree twins
    isWorktree: i % 10 === 0,
    lastTimestamp: new Date(1_755_000_000_000 + i * 1000).toISOString(),
    size: 1024,
    cwd: '/repo',
    projectPath: '-repo',
  }))
  const tabs: Record<string, Tab> = {}
  const sessions: Record<string, Session> = {}
  const tabOrder: string[] = []
  for (let i = 0; i < 30; i++) {
    const tabId = `tab-${i}`
    tabOrder.push(tabId)
    // SAFETY: benchmark fixture — dedupeHistoryEntries reads only sessionId,
    // agentSessionId, and run.provider from these records.
    tabs[tabId] = { sessionId: `open-${i}` } as Tab
    const openSession = {
      agentSessionId: `hist-${i * 7}`,
      run: { provider: 'claude-code' },
    }
    // SAFETY: benchmark fixture — see the invariant above.
    sessions[`open-${i}`] = openSession as unknown as Session
  }
  const lookup = { tabs, sessions, tabOrder }

  // Verbatim pre-change dedupe: linear tabOrder scan per history row.
  const findOpenTabScan = (sessionId: string, provider: string): string | null => {
    for (const tabId of tabOrder) {
      const tab = tabs[tabId]
      if (!tab) continue
      const sess = sessions[tab.sessionId]
      if (
        (tab.sessionId === sessionId || sess?.agentSessionId === sessionId) &&
        (!provider || sess.run.provider === provider)
      )
        return tabId
    }
    return null
  }
  const before = bench('dedupe/scan', 100, () => {
    historySessions.filter((meta) => !findOpenTabScan(meta.sessionId, meta.provider))
  })
  const after = bench('dedupe/set', 100, () => {
    dedupeHistoryEntries(historySessions, lookup)
  })
  record('history dedupe against open tabs (3k sessions × 30 tabs)', '100 scan batches', before, after)

  const entries = dedupeHistoryEntries(historySessions, lookup)
  const entryKeyOld = (entry: (typeof entries)[number]): string =>
    entry.kind === 'history' ? `${entry.meta.provider}:${entry.meta.sessionId}` : 'open'
  const oldOrder = new Map<string, number>()
  const oldTs = new Map<string, number>()
  const sortBefore = bench('order/comparator-keys', 100, () => {
    const byTimestamp = [...entries].sort((a, b) => {
      const ka = entryKeyOld(a)
      const kb = entryKeyOld(b)
      // SAFETY: every entry in this fixture is kind 'history', so `meta` is present.
      const ta = oldTs.get(ka) ?? (oldTs.set(ka, Date.parse((a as { meta: SessionMeta }).meta.lastTimestamp) || 0), oldTs.get(ka)!)
      // SAFETY: every entry in this fixture is kind 'history', so `meta` is present.
      const tb = oldTs.get(kb) ?? (oldTs.set(kb, Date.parse((b as { meta: SessionMeta }).meta.lastTimestamp) || 0), oldTs.get(kb)!)
      return tb - ta
    })
    for (const entry of byTimestamp) {
      const key = entryKeyOld(entry)
      if (!oldOrder.has(key)) oldOrder.set(key, oldOrder.size)
    }
    byTimestamp.sort((a, b) => oldOrder.get(entryKeyOld(a))! - oldOrder.get(entryKeyOld(b))!)
  })
  const frozen = new FrozenEntryOrder()
  const sortAfter = bench('order/decorated', 100, () => {
    frozen.sort(entries, true)
  })
  record('picker frozen-order sort (settled, ~3k entries)', '100 renders', sortBefore, sortAfter)
}

// ───────────────────────────────────────────────────────────────────────────
console.log('── summary table (markdown) ──\n')
console.log('| Benchmark | Before | After | Reduction |')
console.log('|---|---|---|---|')
for (const r of results) {
  const reduction = `${((1 - r.afterMs / r.beforeMs) * 100).toFixed(1)}%`
  const fmt = (v: number) => (r.unit.includes('identities') ? String(Math.round(v)) : `${v.toFixed(2)} ms`)
  console.log(`| ${r.name} (${r.unit}) | ${fmt(r.beforeMs)} | ${fmt(r.afterMs)} | ${reduction} |`)
}

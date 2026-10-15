/**
 * The server half of a cold session open, one phase at a time, on the same
 * fixtures as `session-open.ts`: read the newest ten turns of the transcript,
 * store prompt images, project tool results, defer tool inputs, and serialize
 * the answer.
 *
 * Run with: bun tests/benchmarks/session-open-server.ts [--busy]
 *
 * --busy keeps the event loop about 60% busy in 3 ms slices, as a host does
 * while agents stream, so every awaited read waits behind other work.
 *
 * It imports the server source directly. It does not start a server, and it
 * writes only to a temporary directory.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodePathAsFolder } from '@solus/contracts/types'
import { INITIAL_HISTORY_TURNS } from '@solus/client-core/session-history-page'
import { loadClaudeHistoryPage } from '@solus/server/execution/agents/claude/claude-history-page'
import { storePromptImages } from '@solus/server/data/assets/transcript-images'
import { projectSessionHistory } from '@solus/server/data/sessions/result-projection'
import { deferSavedArtifactHtml, deferSessionToolInputs } from '@solus/server/data/sessions/session-tool-inputs'
import { writeFixtures } from './session-open-fixtures'

const root = mkdtempSync(join(tmpdir(), 'solus-open-server-bench-'))
const project = join(root, 'project')
const fixtures = writeFixtures(join(root, 'home'), project)
const assets = join(root, 'assets')
const busy = process.argv.includes('--busy')
  ? setInterval(() => { const until = performance.now() + 3; while (performance.now() < until) { /* other work on the loop */ } }, 2)
  : null

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

const goal: { server: { busyReadMs: Record<string, number> } } = JSON.parse(readFileSync(join(import.meta.dir, 'session-open-goal.json'), 'utf8'))
const misses: string[] = []

try {
  console.log('fixture           msgs   read  images  project  defer  stringify  total   wire KB')
  for (const fixture of fixtures) {
    const file = join(root, 'home', '.claude', 'projects', encodePathAsFolder(project), `${fixture.sessionId}.jsonl`)
    const phases = { read: [] as number[], images: [] as number[], project: [] as number[], defer: [] as number[], stringify: [] as number[] }
    let messages = 0
    let wireBytes = 0
    for (let run = 0; run < 12; run++) {
      let t = performance.now()
      const page = await loadClaudeHistoryPage(file, INITIAL_HISTORY_TURNS)
      phases.read.push(performance.now() - t)
      t = performance.now()
      const stored = storePromptImages(page.messages, assets)
      phases.images.push(performance.now() - t)
      t = performance.now()
      const projected = projectSessionHistory(stored)
      phases.project.push(performance.now() - t)
      t = performance.now()
      // The desktop and web clients ask for the page without saved artifact HTML.
      const deferred = deferSessionToolInputs(deferSavedArtifactHtml(projected))
      phases.defer.push(performance.now() - t)
      t = performance.now()
      const wire = JSON.stringify(deferred)
      phases.stringify.push(performance.now() - t)
      messages = deferred.length
      wireBytes = Buffer.byteLength(wire)
    }
    // The first two runs warm the JIT.
    const m = Object.fromEntries(Object.entries(phases).map(([name, values]) => [name, median(values.slice(2))]))
    const total = m.read + m.images + m.project + m.defer + m.stringify
    const limit = goal.server.busyReadMs[fixture.key]
    if (busy && limit !== undefined && m.read > limit) misses.push(`${fixture.key} read ${m.read.toFixed(1)} > ${limit}`)
    console.log(`${fixture.key.padEnd(16)} ${String(messages).padStart(5)} ${m.read.toFixed(1).padStart(6)} ${m.images.toFixed(1).padStart(7)} ${m.project.toFixed(1).padStart(8)} ${m.defer.toFixed(1).padStart(6)} ${m.stringify.toFixed(1).padStart(10)} ${total.toFixed(1).padStart(6)} ${(wireBytes / 1024).toFixed(0).padStart(9)}`)
  }
  if (busy) console.log(misses.length ? `goal MISS: ${misses.join(', ')}` : 'goal met: busy reads within session-open-goal.json')
} finally {
  if (busy) clearInterval(busy)
  rmSync(root, { recursive: true, force: true })
}

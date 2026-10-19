/**
 * Data-path timings for the native-mobile workloads in
 * `tests/fixtures/mobile-workloads.ts`: building a long conversation, deriving
 * its feed rows, and applying one streamed chunk.
 *
 * Bun's JIT on a desktop CPU is not Hermes on a phone, and none of this
 * renders. Use the numbers to compare two revisions on one machine, never as
 * a device claim. The machine's load is recorded with every run, because a
 * loaded machine changes them (docs/plans/mobile-compiler-coverage.md).
 *
 *   bun scripts/measure-mobile-workloads.ts [--out=<file.json>]
 */
import { cpus, loadavg } from 'node:os'
import { writeFileSync } from 'node:fs'
import { conversation, feedRows, streamChunk, streamReply } from '../tests/fixtures/mobile-workloads'

const SIZES = [100, 1_000, 2_000, 4_000]
const STREAM_CHUNKS = 500

/** Microseconds: a streamed chunk takes less than one. */
type Distribution = { medianUs: number; p95Us: number; samples: number }

function distribution(samplesMs: number[]): Distribution {
  const sorted = [...samplesMs].sort((a, b) => a - b)
  const at = (fraction: number): number => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? 0
  return { medianUs: microseconds(at(0.5)), p95Us: microseconds(at(0.95)), samples: sorted.length }
}

function microseconds(ms: number): number {
  return Math.round(ms * 100_000) / 100
}

function timed(runs: number, work: () => void): number[] {
  work()
  return Array.from({ length: runs }, () => {
    const start = performance.now()
    work()
    return performance.now() - start
  })
}

function measureSize(turns: number) {
  const build = distribution(timed(5, () => { conversation(turns) }))
  const model = conversation(turns)
  const rows = feedRows(model).length
  const feedRowsDerived = distribution(timed(7, () => { feedRows(model) }))
  const streaming = conversation(turns)
  const chunkTimes: number[] = []
  let feedRebuilds = 0
  streamReply(streaming, 1)
  for (let index = 0; index < STREAM_CHUNKS; index++) {
    const start = performance.now()
    const step = streamChunk(streaming)
    chunkTimes.push(performance.now() - start)
    if (step.orderChanged) feedRebuilds++
  }
  return { turns, rows, build, feedRowsDerived, streamedChunk: distribution(chunkTimes), feedRebuildsWhileStreaming: feedRebuilds }
}

const results = SIZES.map(measureSize)
const report = {
  createdAt: new Date().toISOString(),
  note: 'Bun data-path timings; not renders, not Hermes, not a device.',
  machine: { cpu: cpus()[0]?.model ?? 'unknown', cores: cpus().length, loadAverage: loadavg().map((load) => Math.round(load * 100) / 100), bun: process.versions.bun },
  results,
}
for (const result of results) {
  console.log(`${result.turns} turns (${result.rows} rows): build ${result.build.medianUs} µs, feed rows ${result.feedRowsDerived.medianUs} µs, streamed chunk ${result.streamedChunk.medianUs} µs (p95 ${result.streamedChunk.p95Us}), feed rebuilds while streaming ${result.feedRebuildsWhileStreaming}`)
}
const out = process.argv.find((arg) => arg.startsWith('--out='))?.slice('--out='.length)
if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)

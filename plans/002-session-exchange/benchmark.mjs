// Isolated SQLite cost study. No provider calls, live data, or application imports.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import { sql } from './statements.mjs'

const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8')
const warmup = 200
const samples = 2000
const prompt = 'x'.repeat(1024)
const result = 'y'.repeat(8192)
const execution = JSON.stringify({ cwd: '/disposable/project', model: 'fixture-model', permissionMode: 'ask' })

function summarize(values) {
  values.sort((a, b) => a - b)
  const percentile = fraction => Number(values[Math.ceil(values.length * fraction) - 1].toFixed(4))
  return { p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), max: percentile(1) }
}

// A typed turn nobody else depends on makes no call, so only the routed path
// is measured: a delegated child turn through the parent's durable result row
// (insert before launch; settle + result in one commit).
function measure(reusePrepared) {
  const directory = mkdtempSync(join(tmpdir(), 'solus-exchange-benchmark-'))
  const db = new DatabaseSync(join(directory, 'benchmark.sqlite'))
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000')
    db.exec(schema)
    const prepared = reusePrepared ? Object.fromEntries(Object.entries(sql).map(([name, text]) => [name, db.prepare(text)])) : null
    const query = (name, parameters) => (prepared ? prepared[name] : db.prepare(sql[name])).all(...parameters)
    const timings = { total: [], beforeLaunch: [], completion: [] }
    for (let index = 0; index < warmup + samples; index++) {
      const id = `M${index}`
      const session = `child${index}`
      const start = performance.now()
      query('insert', [id, 'owner', 'owner', 'instruction', 'parent', session, 'parent', prompt, '{}', null, null,
        'running', 1, 'codex', execution, index, index, null])
      const launch = performance.now()
      db.exec('BEGIN IMMEDIATE')
      query('settle', [id, 'owner', 'owner', 'parent', session, prompt, 'completed', 'codex', execution,
        'provider-thread', `provider-${id}`, result, null, index, index, index])
      query('insert', [`result:${id}:parent`, 'owner', 'owner', 'result', session, 'parent', null, null, '{}', id, null,
        'queued', 0, null, null, index, null, null])
      db.exec('COMMIT')
      const end = performance.now()
      if (index >= warmup) {
        timings.total.push(end - start)
        timings.beforeLaunch.push(launch - start)
        timings.completion.push(end - launch)
      }
    }
    return { mode: 'routed', reusePrepared, milliseconds: Object.fromEntries(Object.entries(timings).map(([name, values]) => [name, summarize(values)])) }
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
}

console.log(JSON.stringify({
  measuredAt: new Date().toISOString(), node: process.version, platform: process.platform,
  warmup, samples, promptBytes: prompt.length, resultBytes: result.length,
  settings: 'WAL, synchronous=NORMAL, foreign_keys=ON, default autocheckpoint',
  scope: 'Sequential single-connection DB calls only. Not the whole app. No provider, transport, contention, or live DB. routed results are queued (the parent is busy) so no running-index conflict arises across samples.',
  results: [false, true].map(measure),
}, null, 2))

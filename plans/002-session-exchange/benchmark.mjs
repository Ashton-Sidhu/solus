// Isolated SQLite cost study. No provider calls, live data, or application imports.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import { sql } from './statements.mjs'

const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8')
const ledgerSource = readFileSync(new URL('../../packages/server/src/sessions/turn-ledger.ts', import.meta.url), 'utf8')
const ledgerSchema = ledgerSource.match(/const SCHEMA = `([\s\S]*?)`/)[1]
const baseline = {
  start: `INSERT INTO session_turn (turn_id, prompt_id, session_id, user_id, seat_user_id, provider, state, created_at, started_at, settled_at)
    VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, NULL) ON CONFLICT(turn_id) DO NOTHING`,
  settle: "UPDATE session_turn SET state = ?, settled_at = ? WHERE turn_id = ? AND state = 'running'",
}
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

// ledger: today's two best-effort writes. idle: the proposed idle child path
// through the durable parent input (3 DML, 2 commits).
function measure(mode, reusePrepared) {
  const directory = mkdtempSync(join(tmpdir(), 'solus-exchange-benchmark-'))
  const db = new DatabaseSync(join(directory, 'benchmark.sqlite'))
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000')
    db.exec(mode === 'ledger' ? ledgerSchema : schema)
    const statements = mode === 'ledger' ? baseline : sql
    const prepared = reusePrepared ? Object.fromEntries(Object.entries(statements).map(([name, text]) => [name, db.prepare(text)])) : null
    const query = (name, parameters) => {
      const statement = prepared ? prepared[name] : db.prepare(statements[name])
      return mode === 'ledger' ? statement.run(...parameters) : statement.all(...parameters)
    }
    const timings = { total: [], beforeLaunch: [], completion: [] }
    for (let index = 0; index < warmup + samples; index++) {
      const id = `M${index}`
      const start = performance.now()
      if (mode === 'ledger') {
        query('start', [id, `P${index}`, 'child', 'owner', 'owner', 'codex', index, index])
      } else {
        query('acceptRunning', [id, `C${index}`, 'owner', 'fixture-fingerprint', 'auto', 'parent', 'child', 'parent', prompt, 'owner', 'codex', execution, index, index])
      }
      const launch = performance.now()
      const acceptance = launch
      if (mode === 'ledger') {
        query('settle', ['completed', index, id])
      } else {
        db.exec('BEGIN IMMEDIATE')
        query('settle', ['completed', result, null, 'provider-thread', `provider-${id}`, index, id])
        query('reply', [index, id])
        db.exec('COMMIT')
      }
      const end = performance.now()
      if (index >= warmup) {
        timings.total.push(end - start)
        timings.beforeLaunch.push(launch - start)
        timings.completion.push(end - acceptance)
      }
    }
    return { mode, reusePrepared, milliseconds: Object.fromEntries(Object.entries(timings).map(([name, values]) => [name, summarize(values)])) }
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
}

console.log(JSON.stringify({
  measuredAt: new Date().toISOString(), node: process.version, platform: process.platform,
  warmup, samples, promptBytes: prompt.length, resultBytes: result.length,
  settings: 'WAL, synchronous=NORMAL, foreign_keys=ON, default autocheckpoint',
  scope: 'Sequential single-connection DB calls only. Baseline is the existing ledger, not the whole app. No provider, transport, contention, or live DB.',
  results: [false, true].flatMap(reusePrepared => ['ledger', 'idle'].map(mode => measure(mode, reusePrepared))),
}, null, 2))

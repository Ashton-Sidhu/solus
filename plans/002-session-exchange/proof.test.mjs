// Executable design evidence, not production runtime code. Only disposable DBs.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { sql } from './statements.mjs'

const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8')
const execution = JSON.stringify({ cwd: '/disposable/project', model: 'fixture-model', permissionMode: 'ask' })

// ---------------------------------------------------------------- fixture

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'solus-exchange-design-'))
  const path = join(directory, 'proof.sqlite')
  let db
  const trace = []
  function open() {
    db = new DatabaseSync(path)
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
  }
  open()
  db.exec(schema)
  return {
    get db() { return db },
    path,
    trace,
    query(name, parameters = []) {
      trace.push({ name, sql: sql[name], parameters })
      return db.prepare(sql[name]).all(...parameters).map(row => ({ ...row }))
    },
    control(statement) {
      trace.push({ name: statement, sql: statement, parameters: [] })
      db.exec(statement)
    },
    row(id) { return db.prepare('SELECT * FROM session_message WHERE message_id = ?').get(id) },
    count(where = '1=1') { return db.prepare(`SELECT count(*) AS n FROM session_message WHERE ${where}`).get().n },
    reopen() { db.close(); open() },
    close() { db.close(); rmSync(directory, { recursive: true, force: true }) },
  }
}

// Commits are explicit COMMITs plus autocommitted data statements.
function counts(trace) {
  const calls = trace.filter(row => /^(INSERT|UPDATE|SELECT)/.test(row.sql)).length
  let commits = 0
  let open = false
  for (const row of trace) {
    if (row.name === 'BEGIN IMMEDIATE') open = true
    else if (row.name === 'COMMIT') { open = false; commits++ }
    else if (!open && /^(INSERT|UPDATE)/.test(row.sql)) commits++
  }
  return { calls, commits }
}

// ------------------------------------------------------- host model (memory)
// The production host keeps exactly this in memory: which live turns already
// have a row, and whose wake routes and consumed steers settle with them.

function host(f) {
  return { f, turns: new Map(), busy: new Set() }
}

function insert(f, row) {
  return f.query('insert', [row.id, 'owner', row.seat ?? null, row.kind ?? 'instruction',
    row.sender ?? null, row.recipient, row.reply ?? null, row.text ?? null, row.options ?? '{}',
    row.source ?? null, row.consumedBy ?? null, row.state, row.attempt ?? 0, row.provider ?? null,
    row.execution ?? null, row.now ?? 100, row.startedAt ?? null, row.settledAt ?? null])
}

const runningFields = now => ({ state: 'running', attempt: 1, seat: 'owner', provider: 'codex', execution, startedAt: now })

// Start a turn on an idle session. A row is written first only when someone
// other than the author depends on it: a sender (agent tool or card).
function start(h, { id = 'M1', session = 'child', sender = null, reply = null, text = 'Build the login API', now = 100 } = {}) {
  const written = sender !== null || reply !== null
  if (written) assert.equal(insert(h.f, { id, sender, recipient: session, reply, text, now, ...runningFields(now) }).length, 1)
  h.turns.set(id, { id, session, sender, text, written, startedAt: now, routes: new Set(reply ? [reply] : []) })
  h.busy.add(session)
  return id
}

// Busy target: save the input now; it starts inside the previous settlement.
function enqueue(h, { id, session = 'child', sender = null, reply = null, text = 'Follow up', now = 110 }) {
  assert.equal(insert(h.f, { id, sender, recipient: session, reply, text, state: 'queued', now }).length, 1)
  return id
}

// Steering accepted by the provider. Persisted only when a sender exists.
function steer(h, turnId, { id, sender = null, reply = null, text = 'Also add rate limiting', now = 115 }) {
  const turn = h.turns.get(turnId)
  if (sender !== null) {
    assert.equal(insert(h.f, { id, sender, recipient: turn.session, reply, text, consumedBy: turnId,
      state: 'consumed', now, settledAt: now }).length, 1)
  }
  if (reply) turn.routes.add(reply)
}

// wait_for_session: one write either way. An unrouted turn becomes durable
// with the waiter as its route; a written turn gets a textless consumed row.
function wait(h, turnId, waiter, now = 118) {
  const turn = h.turns.get(turnId)
  if (!turn.written) {
    assert.equal(insert(h.f, { id: turnId, sender: turn.sender, recipient: turn.session, reply: waiter,
      text: turn.text, now: turn.startedAt, ...runningFields(turn.startedAt) }).length, 1)
    turn.written = true
  } else {
    assert.equal(insert(h.f, { id: `wait:${turnId}:${waiter}`, sender: waiter, recipient: turn.session,
      reply: waiter, consumedBy: turnId, state: 'consumed', now, settledAt: now }).length, 1)
  }
  turn.routes.add(waiter)
}

// Settle a turn. A turn nobody depends on writes nothing: its prompt and reply
// live in the provider transcript. Otherwise one transaction: settle, one
// result row per distinct wake route (born running when the recipient is
// idle), and the next queued row of the same session.
function settle(h, turnId, { state = 'completed', result = 'API built', error = null, next = null, failAfter = null, now = 130 } = {}) {
  const f = h.f
  const turn = h.turns.get(turnId)
  const recorded = turn.written || turn.routes.size > 0
  const grouped = turn.routes.size > 0 || (recorded && next !== null)
  if (grouped) f.control('BEGIN IMMEDIATE')
  try {
    if (recorded) {
      const settled = f.query('settle', [turn.id, 'owner', 'owner', turn.sender, turn.session, turn.text,
        state, 'codex', execution, 'provider-thread', `provider-${turn.id}`, result, error, turn.startedAt, turn.startedAt, now])
      if (!settled.length) { if (grouped) f.control('COMMIT'); return [] }
    }
    if (failAfter === 'settle') throw new Error('Injected interruption')
    const delivered = []
    for (const recipient of turn.routes) {
      // A route to the turn's own session (a coordinator) only resumes a turn
      // killed by a restart. Normal settlement never wakes the turn's own session.
      if (recipient === turn.session) continue
      const idle = !h.busy.has(recipient)
      const id = `result:${turn.id}:${recipient}`
      const fields = idle ? runningFields(now) : { state: 'queued' }
      assert.equal(insert(f, { id, kind: 'result', sender: turn.session, recipient, source: turn.id, now, ...fields }).length, 1)
      delivered.push({ id, recipient, running: fields.state === 'running' })
    }
    if (failAfter === 'reply') throw new Error('Injected interruption')
    if (next) assert.equal(f.query('dispatch', ['owner', 'codex', execution, now, next]).length, 1)
    if (grouped) f.control('COMMIT')
    h.turns.delete(turnId)
    h.busy.delete(turn.session)
    for (const result of delivered.filter(r => r.running)) {
      h.turns.set(result.id, { id: result.id, session: result.recipient, sender: null, text: null, written: true, startedAt: now, routes: new Set() })
      h.busy.add(result.recipient)
    }
    if (next) {
      const row = f.row(next)
      h.turns.set(next, { id: next, session: turn.session, sender: row.sender_session_id, text: row.text, written: true, startedAt: now, routes: new Set(row.reply_session_id ? [row.reply_session_id] : []) })
      h.busy.add(turn.session)
    }
    return delivered.map(r => r.id)
  } catch (err) {
    if (grouped) f.control('ROLLBACK')
    throw err
  }
}

// Boot, in one transaction. Every turn a previous process left running was
// killed with it: requeue killed result deliveries (at-least-once), fail
// everything else and owe its outcome to each wake route.
function recoverAtBoot(f, now = 200) {
  f.control('BEGIN IMMEDIATE')
  const rows = f.query('recover')
  const owed = []
  for (const row of rows.filter(r => r.state === 'running')) {
    if (row.kind === 'result') { f.query('requeue', ['host restarted', row.message_id]); continue }
    f.query('settle', [row.message_id, row.actor_user_id, row.seat_user_id, null, row.recipient_session_id, row.text,
      'failed', row.provider, row.execution_json, null, null, null, 'host restarted', row.created_at, row.started_at, now])
    const routes = new Set(row.reply_session_id ? [row.reply_session_id] : [])
    for (const r of f.query('consumedRoutes', [row.message_id])) routes.add(r.reply_session_id)
    for (const recipient of routes) {
      insert(f, { id: `result:${row.message_id}:${recipient}`, kind: 'result', sender: row.recipient_session_id,
        recipient, source: row.message_id, state: 'queued', now })
      owed.push(recipient)
    }
  }
  f.control('COMMIT')
  return owed
}

// ------------------------------------------------------------- normal paths

test('ordinary typed turn: no database call from launch to settlement', () => {
  // WHY: nobody reads a row for a turn no other party depends on. Its prompt
  // and reply live in the provider transcript, and session records already
  // mark it interrupted if the host dies.
  const f = fixture()
  try {
    const h = host(f)
    start(h, { id: 'T1', session: 'main', text: 'Refactor the parser' })
    assert.deepEqual(settle(h, 'T1'), [])
    assert.deepEqual(counts(f.trace), { calls: 0, commits: 0 })
    assert.equal(f.count(), 0)
  } finally { f.close() }
})

test('delegation round trip, idle parent: four statements and three commits for two turns', () => {
  const f = fixture()
  try {
    const h = host(f)
    start(h, { id: 'M1', sender: 'parent', reply: 'parent' })
    assert.deepEqual(settle(h, 'M1'), ['result:M1:parent'])
    const parentTurn = f.row('result:M1:parent')
    assert.equal(parentTurn.state, 'running', 'Delivery and wake are one write')
    assert.equal(parentTurn.text, null, 'The result payload is not copied')
    assert.equal(parentTurn.reply_session_id, null, 'A result never starts a reply chain')
    assert.deepEqual(settle(h, 'result:M1:parent', { result: 'Reviewed' }), [])
    assert.deepEqual(counts(f.trace), { calls: 4, commits: 3 })
    assert.deepEqual(f.trace.filter(r => !r.name.startsWith('BEGIN') && r.name !== 'COMMIT').map(r => r.name),
      ['insert', 'settle', 'insert', 'settle'])
    assert.equal(f.count("state IN ('queued','running')"), 0)
  } finally { f.close() }
})

test('busy parent: the result waits queued and starts inside the parent\'s own settlement', () => {
  const f = fixture()
  try {
    const h = host(f)
    start(h, { id: 'P1', session: 'parent', text: 'Plan the work' })
    start(h, { id: 'M1', sender: 'parent', reply: 'parent' })
    settle(h, 'M1')
    assert.equal(f.row('result:M1:parent').state, 'queued')
    f.trace.length = 0
    settle(h, 'P1', { next: 'result:M1:parent', result: 'Planned' })
    assert.equal(f.row('result:M1:parent').state, 'running')
    assert.equal(f.row('P1'), undefined, 'The parent\'s typed turn writes nothing')
    assert.deepEqual(counts(f.trace), { calls: 1, commits: 1 }, 'Only the dispatch of the waiting result')
  } finally { f.close() }
})

test('busy child: a follow-up is saved now and starts inside the previous settlement', () => {
  const f = fixture()
  try {
    const h = host(f)
    start(h, { id: 'M1', sender: 'parent', reply: 'parent' })
    h.busy.add('parent')
    f.trace.length = 0
    enqueue(h, { id: 'M2', sender: 'parent', reply: 'parent' })
    settle(h, 'M1', { next: 'M2' })
    assert.equal(f.row('M2').state, 'running')
    assert.equal(f.row('M2').attempt_no, 1)
    assert.deepEqual(counts(f.trace), { calls: 4, commits: 2 }, 'enqueue; settle + result + dispatch')
  } finally { f.close() }
})

test('card send without a wake: the outcome is on the row and nothing is delivered to the parent model', () => {
  const f = fixture()
  try {
    const h = host(f)
    start(h, { id: 'C1', sender: 'parent', reply: null, text: 'Try the other approach' })
    assert.deepEqual(settle(h, 'C1', { result: 'Switched approach' }), [])
    assert.deepEqual(counts(f.trace), { calls: 2, commits: 2 })
    const [card] = f.query('sentBy', ['parent'])
    assert.equal(card.state, 'completed')
    assert.equal(card.result_text, 'Switched approach', 'Cards rehydrate from rows, not prose')
  } finally { f.close() }
})

test('duplicate command id conflicts on the primary key and starts nothing', () => {
  const f = fixture()
  try {
    const h = host(f)
    start(h, { id: 'M1', sender: 'parent', reply: 'parent' })
    assert.equal(insert(f, { id: 'M1', recipient: 'child', text: 'x', state: 'queued' }).length, 0)
    assert.equal(f.query('duplicate', ['M1'])[0].state, 'running')
    assert.equal(f.count(), 1)
  } finally { f.close() }
})

test('a repeated terminal event settles nothing twice and delivers no second result', () => {
  const f = fixture()
  try {
    const h = host(f)
    start(h, { id: 'M1', sender: 'parent', reply: 'parent' })
    const turn = { ...h.turns.get('M1'), routes: new Set(['parent']) }
    settle(h, 'M1')
    h.turns.set('M1', turn)
    assert.deepEqual(settle(h, 'M1'), [])
    assert.equal(f.count("kind='result'"), 1)
  } finally { f.close() }
})

// ------------------------------------------------------ steer, wait, cancel

test('steer: a sender\'s steer is one write; a typed steer is none; results fan out once per wake route', () => {
  const f = fixture()
  try {
    const h = host(f)
    start(h, { id: 'M1', sender: 'parent', reply: 'parent' })
    f.trace.length = 0
    steer(h, 'M1', { id: 'S1', sender: 'coordinator', reply: 'coordinator' })
    steer(h, 'M1', { id: 'S2', sender: 'parent', reply: 'parent' })
    steer(h, 'M1', { id: 'S3' })
    assert.deepEqual(counts(f.trace), { calls: 2, commits: 2 })
    assert.equal(f.row('S3'), undefined, 'A typed steer dies with its turn if the host dies')
    assert.deepEqual(settle(h, 'M1').sort(), ['result:M1:coordinator', 'result:M1:parent'])
    assert.equal(f.count("kind='result'"), 2, 'M1 and S2 share the parent route')
  } finally { f.close() }
})

test('wait on an unrouted running turn makes it durable with one write and delivers one result', () => {
  const f = fixture()
  try {
    const h = host(f)
    start(h, { id: 'T1', session: 'child', text: 'Typed by the user' })
    f.trace.length = 0
    wait(h, 'T1', 'parent')
    assert.equal(f.row('T1').state, 'running')
    wait(h, 'T1', 'coordinator')
    assert.deepEqual(counts(f.trace), { calls: 2, commits: 2 })
    assert.deepEqual(settle(h, 'T1').sort(), ['result:T1:coordinator', 'result:T1:parent'])
  } finally { f.close() }
})

test('cancel: the queue drops in one write and the stopped turn\'s outcome still reaches its route', () => {
  const f = fixture()
  try {
    const h = host(f)
    start(h, { id: 'M1', sender: 'parent', reply: 'parent' })
    enqueue(h, { id: 'M2' }); enqueue(h, { id: 'M3', now: 111 })
    f.trace.length = 0
    assert.deepEqual(f.query('cancelSessionQueue', [140, 'child']).map(r => r.message_id), ['M2', 'M3'])
    assert.deepEqual(settle(h, 'M1', { state: 'cancelled', result: null, error: 'interrupted' }), ['result:M1:parent'])
    assert.deepEqual(counts(f.trace), { calls: 3, commits: 2 })
    assert.equal(f.row('M1').state, 'cancelled')
    assert.equal(f.query('cancelQueued', [141, 'M1']).length, 0, 'A running turn stops through the backend')
  } finally { f.close() }
})

test('safe retry re-queues the same row and publishes only the final outcome', () => {
  const f = fixture()
  try {
    const h = host(f)
    start(h, { id: 'M1', sender: 'parent', reply: 'parent' })
    assert.equal(f.query('requeue', ['rate limit', 'M1']).length, 1)
    assert.equal(f.count("kind='result'"), 0)
    assert.equal(f.query('dispatch', ['owner', 'codex', execution, 150, 'M1']).length, 1)
    h.turns.get('M1').startedAt = 150
    assert.deepEqual(settle(h, 'M1'), ['result:M1:parent'])
    assert.equal(f.row('M1').attempt_no, 2)
  } finally { f.close() }
})

// ----------------------------------------------------------------- recovery

for (const point of ['settle', 'reply']) {
  test(`interruption after ${point} rolls back settlement, result and next dispatch together`, () => {
    const f = fixture()
    try {
      const h = host(f)
      start(h, { id: 'M1', sender: 'parent', reply: 'parent' })
      enqueue(h, { id: 'M2' })
      assert.throws(() => settle(h, 'M1', { failAfter: point, next: 'M2' }), /Injected interruption/)
      f.reopen()
      assert.equal(f.row('M1').state, 'running')
      assert.equal(f.row('M2').state, 'queued')
      assert.equal(f.count("kind='result'"), 0)
      assert.deepEqual(settle(h, 'M1', { next: 'M2' }), ['result:M1:parent'])
    } finally { f.close() }
  })
}

test('process exit inside settlement leaves no partial reply', () => {
  const f = fixture()
  try {
    const h = host(f)
    start(h, { id: 'M1', sender: 'parent', reply: 'parent' })
    const script = `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec('PRAGMA foreign_keys = ON');
      db.exec('BEGIN IMMEDIATE');
      db.prepare(${JSON.stringify(sql.settle)}).all('M1','owner','owner','parent','child','x','completed','codex',null,null,null,'r',null,100,100,130);
      db.prepare(${JSON.stringify(sql.insert)}).all('result:M1:parent','owner',null,'result','child','parent',null,null,'{}','M1',null,'queued',0,null,null,130,null,null);
      process.exit(23); // Intentionally no COMMIT, ROLLBACK, or db.close().
    `
    const child = spawnSync(process.execPath, ['-e', script, f.path], { encoding: 'utf8', timeout: 10000 })
    assert.equal(child.status, 23, child.stderr)
    f.reopen()
    assert.equal(f.row('M1').state, 'running')
    assert.equal(f.count("kind='result'"), 0)
  } finally { f.close() }
})

test('restart: a killed routed turn fails and its outcome is owed to every wake route', () => {
  const f = fixture()
  try {
    const h = host(f)
    start(h, { id: 'M1', sender: 'parent', reply: 'parent' })
    steer(h, 'M1', { id: 'S1', sender: 'coordinator', reply: 'coordinator' })
    f.reopen()
    assert.deepEqual(recoverAtBoot(f).sort(), ['coordinator', 'parent'])
    assert.equal(f.row('M1').state, 'failed')
    assert.equal(f.row('M1').error_text, 'host restarted')
    assert.equal(f.row('result:M1:parent').state, 'queued')
  } finally { f.close() }
})

test('restart: a killed result delivery is re-queued (at least once) and queued inputs survive', () => {
  const f = fixture()
  try {
    const h = host(f)
    start(h, { id: 'M1', sender: 'parent', reply: 'parent' })
    settle(h, 'M1')
    enqueue(h, { id: 'M2', session: 'other' })
    f.reopen()
    assert.deepEqual(recoverAtBoot(f), [])
    assert.equal(f.row('result:M1:parent').state, 'queued')
    assert.equal(f.row('M2').state, 'queued')
    const rows = f.query('recover')
    assert.equal(rows.find(r => r.message_id === 'result:M1:parent').delivered_result, 'API built')
  } finally { f.close() }
})

test('coordinator self route: no wake after a normal turn; a turn killed by restart resumes after boot', () => {
  const f = fixture()
  try {
    const h = host(f)
    start(h, { id: 'K1', session: 'coordinator', sender: 'coordinator', reply: 'coordinator', text: 'Coordinate the task' })
    assert.deepEqual(settle(h, 'K1'), [], 'A normal settlement never wakes its own session')
    assert.equal(f.count("kind='result'"), 0)
    start(h, { id: 'K2', session: 'coordinator', sender: 'coordinator', reply: 'coordinator', text: 'Next step' })
    f.reopen()
    assert.deepEqual(recoverAtBoot(f), ['coordinator'])
    const resume = f.row('result:K2:coordinator')
    assert.equal(resume.state, 'queued')
    assert.equal(f.row('K2').error_text, 'host restarted')
  } finally { f.close() }
})

test('restart: an unrouted turn leaves no row; session records already mark it interrupted', () => {
  const f = fixture()
  try {
    const h = host(f)
    start(h, { id: 'T1', session: 'main' })
    f.reopen()
    assert.deepEqual(recoverAtBoot(f), [])
    assert.equal(f.count(), 0)
  } finally { f.close() }
})

test('recovery uses the unfinished index; no triggers; foreign keys hold', () => {
  const f = fixture()
  try {
    const plan = f.db.prepare('EXPLAIN QUERY PLAN ' + sql.recover).all()
    assert.ok(plan.some(row => row.detail.includes('message_unfinished')))
    assert.ok(f.db.prepare('EXPLAIN QUERY PLAN ' + sql.consumedRoutes).all().some(row => row.detail.includes('message_consumed_by')))
    assert.ok(f.db.prepare('EXPLAIN QUERY PLAN ' + sql.sentBy).all().some(row => row.detail.includes('message_by_sender')))
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger'").get().n, 0)
    const h = host(f)
    start(h, { id: 'M1', sender: 'parent', reply: 'parent' }); settle(h, 'M1')
    assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), [])
  } finally { f.close() }
})

test('the database still refuses a second persisted running turn for one session', () => {
  const f = fixture()
  try {
    const h = host(f)
    start(h, { id: 'M1', sender: 'parent', reply: 'parent' })
    assert.throws(() => insert(f, { id: 'M2', recipient: 'child', text: 'x', ...runningFields(101) }), /UNIQUE/)
  } finally { f.close() }
})

// Opt-in evidence export; deterministic fixture values only, never live data.
if (process.env.EXPORT_EXCHANGE_TRACE === '1') {
  const f = fixture()
  try {
    const h = host(f)
    start(h, { id: 'M1', sender: 'parent', reply: 'parent' })
    settle(h, 'M1')
    settle(h, 'result:M1:parent', { result: 'Reviewed' })
    const literal = value => value === null ? 'NULL' : typeof value === 'number'
      ? String(value) : `'${value.replaceAll("'", "''")}'`
    const output = ['-- Generated by proof.test.mjs; fixture values only.',
      '-- Run schema.sql first in a disposable SQLite database.',
      '-- Delegation round trip with an idle parent: 4 data statements, 3 commits, two turns.']
    for (const row of f.trace) {
      let index = 0
      output.push(`\n-- ${row.name}\n${row.sql.replaceAll('?', () => literal(row.parameters[index++]))};`)
    }
    writeFileSync(new URL('./normal-trace.sql', import.meta.url), output.join('\n') + '\n')
  } finally { f.close() }
}

// Executable design evidence, not production runtime code. Only disposable DBs.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8')
import { sql } from './statements.mjs'

const execution = JSON.stringify({ cwd: '/disposable/project', model: 'fixture-model', permissionMode: 'ask' })

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

function fingerprintOf({ sender, target, reply, text, mode }) {
  // Production canonicalization must include the complete typed options,
  // principal and routing, not only the prompt. Fixture options are empty.
  return createHash('sha256').update(JSON.stringify(['owner', sender, target, reply, text, mode, {}])).digest('hex')
}

const defaults = { id: 'M1', key: 'C1', text: 'Build the login API', sender: 'parent', target: 'child', reply: 'parent', mode: 'auto', now: 100 }

function resolveDuplicate(f, options, inserted) {
  if (inserted.length) return { messageId: inserted[0].message_id, created: true }
  const [existing] = f.query('duplicate', ['owner', options.key])
  assert.ok(existing, 'Unrelated message ID collision is not a successful retry')
  assert.equal(existing.request_fingerprint, fingerprintOf(options), 'Command arguments changed')
  return { messageId: existing.message_id, created: false }
}

// Caller has serialized the target session and established that it is idle.
function acceptIdle(f, overrides = {}) {
  const o = { ...defaults, ...overrides }
  const inserted = f.query('acceptRunning', [o.id, o.key, 'owner', fingerprintOf(o), o.mode,
    o.sender, o.target, o.reply, o.text, 'owner', 'codex', execution, o.now, o.now])
  return resolveDuplicate(f, o, inserted)
}

function acceptQueued(f, overrides = {}) {
  const o = { ...defaults, ...overrides }
  const inserted = f.query('acceptQueued', [o.id, o.key, 'owner', fingerprintOf(o), o.mode,
    o.sender, o.target, o.reply, o.text, o.now])
  return resolveDuplicate(f, o, inserted)
}

function dispatch(f, id = 'M1', now = 135) {
  return f.query('dispatch', ['owner', 'codex', execution, now, id])
}

// Settlement transaction: settle the turn, fan out results, and start the next
// queued row of the same session when the host has one ready.
function settle(f, { id = 'M1', state = 'completed', result = 'API built', error = null, next = null, failAfter = null } = {}) {
  f.control('BEGIN IMMEDIATE')
  try {
    const settled = f.query('settle', [state, result, error, 'provider-thread', `provider-${id}`, 130, id])
    if (!settled.length) { f.control('COMMIT'); return [] }
    if (failAfter === 'settle') throw new Error('Injected interruption')
    const replies = f.query('reply', [130, id])
    if (failAfter === 'reply') throw new Error('Injected interruption')
    if (next) assert.equal(dispatch(f, next).length, 1, 'Next queued row must start in the same commit')
    f.control('COMMIT')
    return replies.map(row => row.message_id)
  } catch (error) {
    f.control('ROLLBACK')
    throw error
  }
}

function runToCompletion(f, overrides = {}) {
  const { messageId } = acceptIdle(f, overrides)
  return settle(f, { id: messageId, ...overrides })
}

function counts(trace) {
  const writes = trace.filter(row => /^(INSERT|UPDATE)/.test(row.sql)).length
  const reads = trace.filter(row => /^SELECT/.test(row.sql)).length
  return { writes, reads, transactionStatements: trace.length - writes - reads, total: trace.length }
}

// ---------------------------------------------------------------- normal path

test('idle child request through durable parent input: three DML, no standalone SELECT, two commits', () => {
  const f = fixture()
  try {
    assert.deepEqual(runToCompletion(f), ['result:M1:parent'])
    assert.deepEqual(counts(f.trace), { writes: 3, reads: 0, transactionStatements: 2, total: 5 })
    assert.deepEqual(f.trace.map(row => row.name), ['acceptRunning', 'BEGIN IMMEDIATE', 'settle', 'reply', 'COMMIT'])
    const parentInput = f.row('result:M1:parent')
    assert.equal(parentInput.recipient_session_id, 'parent')
    assert.equal(parentInput.state, 'queued')
    assert.equal(parentInput.reply_session_id, null, 'Result delivery must not start a reply loop')
    assert.equal(parentInput.text, null, 'Do not duplicate the result payload')
    assert.equal(f.row('M1').result_text, 'API built')
    assert.equal(f.row('M1').provider_turn_id, 'provider-M1')
  } finally { f.close() }
})

test('busy child: accept now, start inside the previous settlement; two commits per turn', () => {
  const f = fixture()
  try {
    acceptIdle(f)
    assert.throws(() => acceptIdle(f, { id: 'M2', key: 'C2' }), /UNIQUE/, 'Second turn cannot start while one is active')
    f.trace.length = 0
    assert.equal(acceptQueued(f, { id: 'M2', key: 'C2' }).created, true)
    assert.deepEqual(settle(f, { next: 'M2' }), ['result:M1:parent'])
    assert.equal(f.row('M2').state, 'running')
    assert.equal(f.row('M2').attempt_no, 1)
    assert.deepEqual(settle(f, { id: 'M2' }), ['result:M2:parent'])
    // M2's own cost: accept, then its share of two settlement transactions.
    assert.deepEqual(counts(f.trace), { writes: 6, reads: 0, transactionStatements: 4, total: 10 })
    assert.equal(f.trace.filter(row => row.name === 'COMMIT').length, 2)
  } finally { f.close() }
})

test('ordinary session without a parent writes one row and no result input', () => {
  const f = fixture()
  try {
    assert.deepEqual(runToCompletion(f, { sender: null, reply: null }), [])
    assert.equal(f.count(), 1)
  } finally { f.close() }
})

test('duplicate command returns the saved row; changed arguments are rejected; no relaunch', () => {
  const f = fixture()
  try {
    acceptIdle(f)
    f.reopen()
    assert.deepEqual(acceptIdle(f, { id: 'ignored' }), { messageId: 'M1', created: false })
    assert.throws(() => acceptIdle(f, { text: 'Different task' }), /arguments changed/)
    assert.equal(f.count(), 1)
    assert.equal(f.query('recover')[0].state, 'running')
  } finally { f.close() }
})

test('parent processes a saved result without generating another automatic reply', () => {
  const f = fixture()
  try {
    runToCompletion(f)
    f.trace.length = 0
    assert.equal(dispatch(f, 'result:M1:parent').length, 1)
    assert.deepEqual(settle(f, { id: 'result:M1:parent', result: 'Reviewed' }), [])
    assert.deepEqual(counts(f.trace), { writes: 3, reads: 0, transactionStatements: 2, total: 5 })
    assert.equal(f.count(), 2)
    assert.equal(f.query('recover').length, 0)
  } finally { f.close() }
})

test('each follow-up has its own result on the same child session', () => {
  const f = fixture()
  try {
    runToCompletion(f)
    runToCompletion(f, { id: 'M2', key: 'C2', text: 'Add expired-token coverage', result: 'Coverage added' })
    const results = f.db.prepare("SELECT source_message_id FROM session_message WHERE kind='result' ORDER BY source_message_id").all()
    assert.deepEqual(results.map(row => row.source_message_id), ['M1', 'M2'])
    assert.equal(f.count("recipient_session_id='child' AND attempt_no > 0"), 2)
  } finally { f.close() }
})

// ------------------------------------------------------------------ recovery

test('queued request survives restart and dispatches later', () => {
  const f = fixture()
  try {
    acceptQueued(f); f.reopen()
    const [row] = f.query('recover')
    assert.equal(row.message_id, 'M1')
    assert.equal(row.state, 'queued')
    assert.equal(dispatch(f).length, 1)
  } finally { f.close() }
})

test('running row survives restart and is reconciled, never relaunched', () => {
  const f = fixture()
  try {
    acceptIdle(f); f.reopen()
    const [row] = f.query('recover')
    assert.equal(row.state, 'running')
    assert.equal(row.provider_turn_id, null, 'Acceptance is not recorded separately; the row is uncertain')
    assert.equal(dispatch(f).length, 0, 'Only queued rows dispatch')
    assert.throws(() => acceptIdle(f, { id: 'M2', key: 'C2' }), /UNIQUE/)
    assert.deepEqual(settle(f, { state: 'failed', result: null, error: 'host restarted' }), ['result:M1:parent'])
  } finally { f.close() }
})

for (const point of ['settle', 'reply']) {
  test(`settlement interruption after ${point} rolls back result, parent input and next dispatch together`, () => {
    const f = fixture()
    try {
      acceptIdle(f); acceptQueued(f, { id: 'M2', key: 'C2' })
      assert.throws(() => settle(f, { failAfter: point, next: 'M2' }), /Injected interruption/)
      f.reopen()
      assert.equal(f.row('M1').state, 'running')
      assert.equal(f.row('M2').state, 'queued')
      assert.equal(f.count("kind='result'"), 0)
      assert.deepEqual(settle(f, { next: 'M2' }), ['result:M1:parent'])
      assert.equal(f.row('M2').state, 'running')
    } finally { f.close() }
  })
}

test('committed reply survives lost in-memory wake and a duplicate terminal event', () => {
  const f = fixture()
  try {
    runToCompletion(f); f.reopen()
    const [row] = f.query('recover')
    assert.equal(row.message_id, 'result:M1:parent')
    assert.equal(row.delivered_result, 'API built')
    assert.equal(row.state, 'queued', 'Queued in parent, not yet consumed')
    assert.deepEqual(settle(f), [])
    assert.equal(f.count("kind='result'"), 1)
  } finally { f.close() }
})

test('process exit inside settlement leaves no partially committed parent reply', () => {
  const f = fixture()
  try {
    acceptIdle(f)
    const script = `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec('PRAGMA foreign_keys = ON');
      db.exec('BEGIN IMMEDIATE');
      db.prepare(${JSON.stringify(sql.settle)}).all('completed', 'interrupted result', null, null, null, 130, 'M1');
      db.prepare(${JSON.stringify(sql.reply)}).all(130, 'M1');
      process.exit(23); // Intentionally no COMMIT, ROLLBACK, or db.close().
    `
    const child = spawnSync(process.execPath, ['-e', script, f.path], { encoding: 'utf8', timeout: 10000 })
    assert.equal(child.error, undefined)
    assert.equal(child.status, 23, child.stderr)
    f.reopen()
    const [row] = f.query('recover')
    assert.equal(row.message_id, 'M1')
    assert.equal(row.state, 'running')
    assert.equal(f.count("kind='result'"), 0)
  } finally { f.close() }
})

test('recovery uses the unfinished index; schema has no triggers; foreign keys hold', () => {
  const f = fixture()
  try {
    const explain = f.db.prepare('EXPLAIN QUERY PLAN ' + sql.recover).all()
    assert.ok(explain.some(row => row.detail.includes('message_unfinished')))
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger'").get().n, 0)
    runToCompletion(f)
    assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), [])
  } finally { f.close() }
})

test('safe retry re-queues the same row and publishes only the final outcome', () => {
  const f = fixture()
  try {
    acceptIdle(f)
    assert.equal(f.query('requeue', ['rate limit', 'M1']).length, 1)
    assert.equal(f.count("kind='result'"), 0, 'No interim result for the abandoned attempt')
    f.reopen()
    assert.equal(f.query('recover')[0].state, 'queued')
    assert.equal(dispatch(f).length, 1)
    assert.deepEqual(settle(f), ['result:M1:parent'])
    const row = f.row('M1')
    assert.equal(row.attempt_no, 2)
    assert.equal(row.seat_user_id, 'owner')
    assert.equal(f.count("kind='result'"), 1)
  } finally { f.close() }
})

// ----------------------------------------------------------------- questions

function ask(f, { id = 'Q1', turn = 'M1' } = {}) {
  return f.query('question', [id, id, id, 'Which auth library?', JSON.stringify({ questionId: id, revision: 1 }), 125, turn])
}

test('question from a routed running turn is one durable parent input; unrouted turns write nothing', () => {
  const f = fixture()
  try {
    acceptIdle(f, { sender: null, reply: null })
    assert.equal(ask(f).length, 0, 'No route, no row')
    settle(f)
    acceptIdle(f, { id: 'M2', key: 'C2' })
    f.trace.length = 0
    assert.deepEqual(ask(f, { turn: 'M2' }).map(row => row.message_id), ['question:Q1'])
    assert.deepEqual(counts(f.trace), { writes: 1, reads: 0, transactionStatements: 0, total: 1 })
    const question = f.row('question:Q1')
    assert.equal(question.recipient_session_id, 'parent')
    assert.equal(question.source_message_id, 'M2')
    assert.equal(question.reply_session_id, null, 'The parent answers with a command, not a reply')
    assert.equal(ask(f, { turn: 'M2' }).length, 0, 'Repeated provider event writes nothing new')
  } finally { f.close() }
})

test('parent dispatches a question only while the asking turn still runs; otherwise it expires', () => {
  const f = fixture()
  try {
    acceptIdle(f); ask(f)
    assert.deepEqual(dispatch(f, 'question:Q1').map(row => row.kind), ['question'])
    settle(f, { id: 'question:Q1', result: 'Answered' })
    acceptIdle(f, { id: 'M2', key: 'C2', target: 'child2' }); ask(f, { id: 'Q2', turn: 'M2' })
    settle(f, { id: 'M2' })
    assert.equal(dispatch(f, 'question:Q2').length, 0)
    assert.equal(f.query('expireQuestion', [140, 'question:Q2']).length, 1)
    assert.equal(f.row('question:Q2').state, 'cancelled')
    assert.equal(f.query('recover').filter(row => row.kind === 'question').length, 0)
  } finally { f.close() }
})

function answer(f, { id = 'A1', key = 'A1', from = 'parent', target = 'child', question = 'question:Q1' } = {}) {
  return f.query('answer', [id, key, 'owner', `answer:${key}`, from, target, 'Use passport', JSON.stringify({ questionId: 'Q1', answers: { library: 'passport' } }), question, 126])
}

test('answer is saved before the responder is called, then consumed by the running turn or failed', () => {
  const f = fixture()
  try {
    acceptIdle(f); ask(f)
    f.trace.length = 0
    assert.equal(answer(f).length, 1)
    assert.deepEqual(f.query('consume', [127, 'A1']), [{ message_id: 'A1', consumed_by_message_id: 'M1' }])
    assert.deepEqual(counts(f.trace), { writes: 2, reads: 0, transactionStatements: 0, total: 2 })
    assert.equal(answer(f).length, 0, 'Duplicate answer command writes nothing')
    // A human answer with no routed question row uses the same command.
    assert.equal(answer(f, { id: 'A2', key: 'A2', from: null, question: null }).length, 1)
    assert.equal(f.query('consume', [128, 'A2'])[0].consumed_by_message_id, 'M1')
    settle(f)
    assert.equal(answer(f, { id: 'A3', key: 'A3' }).length, 1)
    assert.equal(f.query('consume', [131, 'A3']).length, 0, 'Nothing is running to accept it')
    assert.equal(f.query('fail', ['stale', 131, 'A3']).length, 1)
    assert.equal(dispatch(f, 'A3').length, 0, 'An answer is never a turn')
    assert.equal(f.count("kind='result'"), 1, 'Answers never fan out results')
  } finally { f.close() }
})

test('answer in flight at restart is failed as stale', () => {
  const f = fixture()
  try {
    acceptIdle(f); ask(f); answer(f); f.reopen()
    assert.deepEqual(f.query('failStaleAnswers', [200]).map(row => row.message_id), ['A1'])
    assert.equal(f.row('A1').state, 'failed')
  } finally { f.close() }
})

// --------------------------------------------------------------------- steer

test('steer accepted by the running turn is consumed; settlement replies once per distinct reply session', () => {
  const f = fixture()
  try {
    acceptIdle(f)
    acceptQueued(f, { id: 'S1', key: 'S1', sender: 'coordinator', reply: 'coordinator', text: 'Also add rate limiting' })
    acceptQueued(f, { id: 'S2', key: 'S2', sender: 'parent', reply: 'parent', text: 'Use bcrypt' })
    f.trace.length = 0
    assert.deepEqual(f.query('consume', [121, 'S1']), [{ message_id: 'S1', consumed_by_message_id: 'M1' }])
    assert.deepEqual(counts(f.trace), { writes: 1, reads: 0, transactionStatements: 0, total: 1 })
    assert.equal(f.query('consume', [122, 'S2']).length, 1)
    const replies = settle(f)
    assert.deepEqual(replies.sort(), ['result:M1:coordinator', 'result:M1:parent'])
    assert.equal(f.count("kind='result'"), 2, 'M1 and S2 share the parent route: one row, not two')
    assert.equal(f.query('recover').filter(row => row.kind === 'instruction').length, 0)
  } finally { f.close() }
})

test('steer refused at a turn boundary leaves the row queued to run as its own turn', () => {
  const f = fixture()
  try {
    runToCompletion(f)
    acceptQueued(f, { id: 'S1', key: 'S1', text: 'Also add rate limiting' })
    assert.equal(f.query('consume', [140, 'S1']).length, 0, 'No running turn; provider would refuse too')
    assert.equal(f.row('S1').state, 'queued')
    assert.equal(dispatch(f, 'S1').length, 1)
    assert.deepEqual(settle(f, { id: 'S1', result: 'Rate limiting added' }), ['result:S1:parent'])
  } finally { f.close() }
})

test('steer-only mode with no running turn fails explicitly and never becomes a turn', () => {
  const f = fixture()
  try {
    acceptQueued(f, { id: 'S1', key: 'S1', mode: 'steer' })
    assert.equal(f.query('consume', [140, 'S1']).length, 0)
    assert.equal(dispatch(f, 'S1').length, 0, 'Steer-only rows are excluded from dispatch')
    assert.equal(f.query('fail', ['not_running', 140, 'S1']).length, 1)
    assert.equal(f.query('recover').length, 0)
  } finally { f.close() }
})

test('a consumed steer cannot be consumed twice or dispatched as a turn', () => {
  const f = fixture()
  try {
    acceptIdle(f)
    acceptQueued(f, { id: 'S1', key: 'S1' })
    f.query('consume', [121, 'S1'])
    assert.equal(f.query('consume', [122, 'S1']).length, 0)
    assert.equal(dispatch(f, 'S1').length, 0)
  } finally { f.close() }
})

// -------------------------------------------------------------------- cancel

test('cancelling a session drops its queue in one write and the running turn settles as cancelled with its outcome routed', () => {
  const f = fixture()
  try {
    acceptIdle(f)
    acceptQueued(f, { id: 'M2', key: 'C2', mode: 'queue' })
    acceptQueued(f, { id: 'M3', key: 'C3', mode: 'queue' })
    f.trace.length = 0
    assert.deepEqual(f.query('cancelSessionQueue', [140, 'child']).map(row => row.message_id), ['M2', 'M3'])
    // Backend interrupt happens here, outside the database. Settlement is the
    // normal path with a cancelled outcome and nothing queued to start next.
    assert.deepEqual(settle(f, { state: 'cancelled', result: null, error: 'interrupted' }), ['result:M1:parent'])
    assert.deepEqual(counts(f.trace), { writes: 3, reads: 0, transactionStatements: 2, total: 5 })
    assert.equal(f.row('M1').state, 'cancelled')
    assert.equal(f.query('recover').map(row => row.message_id).join(), 'result:M1:parent')
  } finally { f.close() }
})

test('cancelling one queued row, or dismissing a queued result, is one write; running rows are untouched', () => {
  const f = fixture()
  try {
    runToCompletion(f)
    acceptIdle(f, { id: 'M2', key: 'C2' })
    assert.equal(f.query('cancelQueued', [140, 'M2']).length, 0, 'A running turn is stopped through the backend, not by this write')
    assert.equal(f.query('cancelQueued', [140, 'result:M1:parent']).length, 1)
    assert.equal(f.row('result:M1:parent').state, 'cancelled')
  } finally { f.close() }
})

// Opt-in evidence export; deterministic fixture values only, never live data.
if (process.env.EXPORT_EXCHANGE_TRACE === '1') {
  const f = fixture()
  try {
    runToCompletion(f)
    const literal = value => value === null ? 'NULL' : typeof value === 'number'
      ? String(value) : `'${value.replaceAll("'", "''")}'`
    const output = ['-- Generated by proof.test.mjs; fixture values only.',
      '-- Run schema.sql first in a disposable SQLite database.',
      '-- 3 data statements + one BEGIN/COMMIT pair; 2 commit boundaries.']
    for (const row of f.trace) {
      let index = 0
      output.push(`\n-- ${row.name}\n${row.sql.replaceAll('?', () => literal(row.parameters[index++]))};`)
    }
    writeFileSync(new URL('./normal-trace.sql', import.meta.url), output.join('\n') + '\n')
  } finally { f.close() }
}

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { WEBHOOK_DELIVERY_ID_TTL_MS } from '@solus/contracts/webhooks'
import { DatabaseSync } from './helpers/bun-sqlite'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync }))

// WHY: plans/029-fresh-database-baseline.md §3.6. One table claims an identity
// before the write it protects, in the same transaction, so a rollback removes
// the claim. Each namespace keeps its own duplicate and expiry policy; none can
// expire or answer another's rows.

let dataDir: string
let receipts: typeof import('@solus/server/data/receipts/operation-receipts')
let schema: typeof import('@solus/server/data/receipts/schema')
let apiReceipts: typeof import('@solus/server/data/workspace/receipts')
let database: typeof import('@solus/server/db/database')
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-operation-receipts-'))
  process.env.SOLUS_DATA_DIR = dataDir
  receipts = await import('@solus/server/data/receipts/operation-receipts')
  schema = await import('@solus/server/data/receipts/schema')
  apiReceipts = await import('@solus/server/data/workspace/receipts')
  database = await import('@solus/server/db/database')
})

afterEach(async () => {
  await resetTestDatabase()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `solus.db${suffix}`), { force: true })
})

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

const T0 = 1_700_000_000_000

interface ReceiptRow { scope: string; namespace: string; key: string; result_id: string | null; expires_at: number | null }

async function rows(): Promise<ReceiptRow[]> {
  const stored = await database.getDatabase().all<ReceiptRow>(sql`SELECT scope, namespace, key, result_id, expires_at FROM ${schema.operationReceipts} ORDER BY scope, namespace, key`)
  return stored.map((row) => ({ ...row, expires_at: row.expires_at === null ? null : Number(row.expires_at) }))
}

describe('claims', () => {
  test('the first claim wins and the same identity is a duplicate; a rolled-back claim is gone, so the retry wins', async () => {
    const db = database.getDatabase()
    expect(await receipts.claimWebhookKey(db, 'wh-1', 'delivery', 'd-1', T0)).toBe(true)
    expect(await receipts.claimWebhookKey(db, 'wh-1', 'delivery', 'd-1', T0 + 1)).toBe(false)

    await expect(db.transaction(async (tx) => {
      expect(await receipts.claimWebhookKey(tx, 'wh-1', 'delivery', 'd-2', T0)).toBe(true)
      throw new Error('the protected write failed')
    })).rejects.toThrow('the protected write failed')
    expect((await rows()).map((row) => row.key)).toEqual(['d-1'])
    expect(await receipts.claimWebhookKey(db, 'wh-1', 'delivery', 'd-2', T0)).toBe(true)
  })

  test('one scope and key is a separate receipt in every namespace', async () => {
    const db = database.getDatabase()
    const hash = 'h'
    expect(await receipts.claimWebhookKey(db, 'shared', 'delivery', 'k', T0)).toBe(true)
    expect(await receipts.claimWebhookKey(db, 'shared', 'replay', 'k', T0)).toBe(true)
    expect(await receipts.claimApiCreate(db, 'shared', 'task', 'k', hash, T0)).toEqual({ outcome: 'claimed' })
    expect(await receipts.claimApiCreate(db, 'shared', 'work', 'k', hash, T0)).toEqual({ outcome: 'claimed' })
    expect(await receipts.claimApiCreate(db, 'shared', 'comment', 'k', hash, T0)).toEqual({ outcome: 'claimed' })
    expect(await receipts.claimAppliedOperation(db, 'k', 'resource')).toBe(true)
    expect((await rows()).map((row) => `${row.scope}/${row.namespace}`)).toEqual([
      'courier-owner/applied-operation',
      'shared/api-create-comment', 'shared/api-create-task', 'shared/api-create-work',
      'shared/webhook-delivery', 'shared/webhook-replay',
    ])
  })

  test('an expired receipt is taken again exactly at its expiry, not one millisecond before', async () => {
    const db = database.getDatabase()
    expect(await receipts.claimWebhookKey(db, 'wh', 'delivery', 'd', T0)).toBe(true)
    const expiresAt = T0 + WEBHOOK_DELIVERY_ID_TTL_MS
    expect(await receipts.claimWebhookKey(db, 'wh', 'delivery', 'd', expiresAt - 1)).toBe(false)
    expect(await receipts.claimWebhookKey(db, 'wh', 'delivery', 'd', expiresAt)).toBe(true)
    expect((await rows())[0].expires_at).toBe(expiresAt + WEBHOOK_DELIVERY_ID_TTL_MS)
  })

  test('an API create duplicate must present the same fingerprint, and answers the stored result once it is complete', async () => {
    const db = database.getDatabase()
    await db.transaction(async (tx) => {
      expect(await receipts.claimApiCreate(tx, 'alice', 'task', 'key-1', 'hash-a', T0)).toEqual({ outcome: 'claimed' })
      // Claimed and not yet completed: never answered as a result.
      expect(await receipts.claimApiCreate(tx, 'alice', 'task', 'key-1', 'hash-a', T0)).toEqual({ outcome: 'incomplete' })
      await receipts.completeApiCreate(tx, 'alice', 'task', 'key-1', 'task-1')
    })
    expect(await receipts.claimApiCreate(db, 'alice', 'task', 'key-1', 'hash-a', T0 + 1)).toEqual({ outcome: 'duplicate', resultId: 'task-1' })
    expect(await receipts.claimApiCreate(db, 'alice', 'task', 'key-1', 'hash-b', T0 + 1)).toEqual({ outcome: 'different-input' })
    // The same key under another authority is another receipt.
    expect(await receipts.claimApiCreate(db, 'bob', 'task', 'key-1', 'hash-b', T0 + 1)).toEqual({ outcome: 'claimed' })
    // Past its horizon the key is free again, whatever the fingerprint.
    expect(await receipts.claimApiCreate(db, 'alice', 'task', 'key-1', 'hash-b', T0 + receipts.API_CREATE_TTL_MS)).toEqual({ outcome: 'claimed' })
  })

  test('an applied operation has no expiry: no claim time takes it and no sweep removes it', async () => {
    const db = database.getDatabase()
    expect(await receipts.claimAppliedOperation(db, 'op-1', 'work-1')).toBe(true)
    expect(await receipts.claimAppliedOperation(db, 'op-1', 'work-1')).toBe(false)
    expect(await receipts.sweepExpiredReceipts(Number.MAX_SAFE_INTEGER)).toBe(0)
    expect(await receipts.claimAppliedOperation(db, 'op-1', 'work-1')).toBe(false)
    expect(await rows()).toEqual([{ scope: 'courier-owner', namespace: 'applied-operation', key: 'op-1', result_id: 'work-1', expires_at: null }])
  })

  test('a receipt with a null identity field is refused', async () => {
    const db = database.getDatabase()
    for (const [scope, namespace, key] of [[null, 'n', 'k'], ['s', null, 'k'], ['s', 'n', null]]) {
      await expect(db.run(sql`INSERT INTO ${schema.operationReceipts} (scope, namespace, key) VALUES (${scope}, ${namespace}, ${key})`)).rejects.toThrow()
    }
    expect(await rows()).toEqual([])
  })
})

describe('sweep', () => {
  test('one sweep removes at most 1000 expired rows across namespaces, oldest first, and keeps unexpired and permanent receipts', async () => {
    const db = database.getDatabase()
    const sweepAt = T0 + 10_000
    const namespaces = ['webhook-delivery', 'webhook-replay', 'api-create-task']
    // 1200 expired rows: expiry T0+1 .. T0+1200, spread over three namespaces.
    const expired = Array.from({ length: 1200 }, (_, index) => sql`(${'scope'}, ${namespaces[index % namespaces.length]}, ${`k-${index}`}, ${T0 + 1 + index})`)
    await db.run(sql`INSERT INTO ${schema.operationReceipts} (scope, namespace, key, expires_at) VALUES ${sql.join(expired, sql`, `)}`)
    expect(await receipts.claimAppliedOperation(db, 'op-permanent', 'r')).toBe(true)
    expect(await receipts.claimWebhookKey(db, 'scope', 'delivery', 'still-fresh', sweepAt)).toBe(true)

    expect(await receipts.sweepExpiredReceipts(sweepAt)).toBe(receipts.RECEIPT_SWEEP_BATCH)
    const remaining = await rows()
    const remainingExpired = remaining.filter((row) => row.expires_at !== null && row.expires_at <= sweepAt)
    expect(remainingExpired).toHaveLength(200)
    // The batch took the oldest expiries; the newest 200 are what is left.
    expect(Math.min(...remainingExpired.map((row) => row.expires_at!))).toBe(T0 + 1001)

    expect(await receipts.sweepExpiredReceipts(sweepAt)).toBe(200)
    expect(await receipts.sweepExpiredReceipts(sweepAt)).toBe(0)
    expect((await rows()).map((row) => row.key).sort()).toEqual(['op-permanent', 'still-fresh'])
  })
})

describe('API creates', () => {
  interface Resource { id: string }
  function fixture(kind: 'task' | 'work' | 'comment' = 'task', authority = 'alice') {
    const calls = { creates: 0, reads: [] as string[] }
    const resource: Resource = { id: `${kind}-1` }
    let readError: Error | null = null
    const run = (key: string, request: string, create: () => Promise<Resource> = async () => { calls.creates += 1; return resource }) =>
      apiReceipts.createWithReceipt(authority, kind, key, request, create, async (id) => {
        calls.reads.push(id)
        if (readError) throw readError
        return { id }
      })
    return { calls, run, hideResource: (error: Error) => { readError = error } }
  }

  test('a lost response is answered by reading the result again; a failed create leaves no receipt, so the retry creates', async () => {
    const { calls, run } = fixture()
    expect(await run('k', '{"title":"a"}')).toEqual({ id: 'task-1' })
    expect(await run('k', '{"title":"a"}')).toEqual({ id: 'task-1' })
    expect(calls).toEqual({ creates: 1, reads: ['task-1'] })
    await expect(run('k', '{"title":"b"}')).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' })

    await expect(run('k2', '{}', async () => { throw new Error('create failed') })).rejects.toThrow('create failed')
    expect((await rows()).map((row) => row.key)).toEqual(['k'])
    expect(await run('k2', '{}')).toEqual({ id: 'task-1' })
    expect(calls.creates).toBe(2)
  })

  test('a duplicate reads under current authorization: a resource deleted or hidden since is not replayed', async () => {
    const { run, hideResource } = fixture()
    await run('k', '{}')
    const { SolusApiError } = await import('@solus/server/admission/workspace-error')
    hideResource(new SolusApiError(404, 'NOT_FOUND', 'Resource not found.'))
    await expect(run('k', '{}')).rejects.toMatchObject({ status: 404 })
    // The receipt stays: the answer is the reader's, never a stored body.
    await expect(run('k', '{}')).rejects.toMatchObject({ status: 404 })
    expect((await rows()).map((row) => row.result_id)).toEqual(['task-1'])
  })

  test('one authority and retry key create a task, a work, and a comment, each answered by its own reader', async () => {
    // WHY: the namespace carries the kind. With equal result ids, a duplicate
    // reaches only the reader of its kind, so no separate result-kind column is needed.
    const kinds = ['task', 'work', 'comment'] as const
    const fixtures = kinds.map((kind) => ({ kind, ...fixture(kind) }))
    for (const { run } of fixtures) expect(await run('one-key', '{}', async () => ({ id: 'same-id' }))).toEqual({ id: 'same-id' })
    for (const { run } of fixtures) expect(await run('one-key', '{}')).toEqual({ id: 'same-id' })
    for (const { calls } of fixtures) expect(calls).toEqual({ creates: 0, reads: ['same-id'] })
    expect((await rows()).map((row) => row.namespace)).toEqual(['api-create-comment', 'api-create-task', 'api-create-work'])
  })
})

describe('two transactions', () => {
  /** Claims `key` in its own transaction, then waits for `finish` to say how the transaction ends. */
  function claimInTransaction(key: string, finish: Promise<'commit' | 'rollback'>, onSent?: () => void): Promise<boolean> {
    return database.getDatabase().transaction(async (tx) => {
      onSent?.()
      const won = await receipts.claimWebhookKey(tx, 'wh', 'delivery', key, T0)
      if ((await finish) === 'rollback') throw new Error('rollback')
      return won
    })
  }

  /** The second claimer sends its insert while the first holds the row. On SQLite the second transaction queues behind the first instead. */
  async function race(first: 'commit' | 'rollback'): Promise<{ first: Promise<boolean>; second: Promise<boolean> }> {
    let finishFirst!: (how: 'commit' | 'rollback') => void
    const firstClaim = claimInTransaction('d', new Promise((resolve) => { finishFirst = resolve }))
    let secondSent!: () => void
    const sent = new Promise<void>((resolve) => { secondSent = resolve })
    const secondClaim = claimInTransaction('d', Promise.resolve('commit'), secondSent)
    if (database.getDatabase().engine === 'postgres') await sent
    finishFirst(first)
    return { first: firstClaim, second: secondClaim }
  }

  test('a second claimer of the same identity loses to a committed first claim', async () => {
    const { first, second } = await race('commit')
    expect(await first).toBe(true)
    expect(await second).toBe(false)
    expect((await rows()).map((row) => row.key)).toEqual(['d'])
  })

  test('a second claimer of the same identity wins after the first claim rolls back', async () => {
    const { first, second } = await race('rollback')
    await expect(first).rejects.toThrow('rollback')
    expect(await second).toBe(true)
    expect((await rows()).map((row) => row.key)).toEqual(['d'])
  })
})

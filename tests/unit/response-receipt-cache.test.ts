import { afterEach, describe, expect, jest, test } from 'bun:test'
import {
  RESPONSE_RECEIPT_MAX_IN_FLIGHT,
  RESPONSE_RECEIPT_TTL_MS,
  ResponseReceiptBudget,
  ResponseReceiptCache,
} from '@solus/server/transports/response-receipt-cache'

afterEach(() => jest.useRealTimers())

describe('WebSocket response receipt retention', () => {
  test('expires settled receipts without waiting for another RPC', async () => {
    jest.useFakeTimers()
    const budget = new ResponseReceiptBudget(4, 1_024)
    const cache = new ResponseReceiptCache(() => 'busy', budget)
    expect(await cache.getOrCreate('one', async () => 'ok')).toBe('ok')
    await Promise.resolve()
    expect(cache.stats().entries).toBe(1)
    expect(budget.stats().settledBytes).toBeGreaterThan(0)

    jest.advanceTimersByTime(RESPONSE_RECEIPT_TTL_MS + 1)
    expect(cache.stats().entries).toBe(0)
    expect(budget.stats()).toEqual({ inFlight: 0, settledBytes: 0 })
  })

  test('does not retain a multi-megabyte settled result', async () => {
    const cache = new ResponseReceiptCache(() => ({ error: 'busy' }))
    await cache.getOrCreate('large', async () => ({ result: 'x'.repeat(3 * 1024 * 1024) }))
    await Promise.resolve()
    expect(cache.stats()).toEqual({ entries: 0, inFlight: 0, settledBytes: 0 })
  })

  test('never evicts in-flight deduplication entries at the admission cap', async () => {
    let started = 0
    const cache = new ResponseReceiptCache(() => 'busy')
    const pending = new Promise<string>(() => {})
    const first = cache.getOrCreate('request-0', () => { started++; return pending })
    for (let index = 1; index < RESPONSE_RECEIPT_MAX_IN_FLIGHT; index++) {
      cache.getOrCreate(`request-${index}`, () => { started++; return pending })
    }
    expect(await cache.getOrCreate('over-cap', async () => 'unexpected')).toBe('busy')
    expect(cache.getOrCreate('request-0', async () => 'duplicate')).toBe(first)
    expect(started).toBe(RESPONSE_RECEIPT_MAX_IN_FLIGHT)
    expect(cache.stats().inFlight).toBe(RESPONSE_RECEIPT_MAX_IN_FLIGHT)
  })

  test('shares in-flight admission across client and closed transport generations', async () => {
    const budget = new ResponseReceiptBudget(2, 1_024)
    const firstClient = new ResponseReceiptCache(() => 'busy', budget)
    const secondClient = new ResponseReceiptCache(() => 'busy', budget)
    const thirdClient = new ResponseReceiptCache(() => 'busy', budget)
    let settleFirst!: (value: string) => void
    const firstPending = new Promise<string>((resolve) => { settleFirst = resolve })
    const secondPending = new Promise<string>(() => {})

    const first = firstClient.getOrCreate('one', () => firstPending)
    expect(firstClient.getOrCreate('one', async () => 'duplicate')).toBe(first)
    secondClient.getOrCreate('two', () => secondPending)
    expect(await thirdClient.getOrCreate('three', async () => 'unexpected')).toBe('busy')
    expect(budget.stats()).toEqual({ inFlight: 2, settledBytes: 0 })

    firstClient.close()
    expect(budget.stats()).toEqual({ inFlight: 2, settledBytes: 0 })
    expect(await thirdClient.getOrCreate('three', async () => 'unexpected')).toBe('busy')

    settleFirst('done')
    await first
    await Promise.resolve()
    expect(budget.stats()).toEqual({ inFlight: 1, settledBytes: 0 })
    expect(await thirdClient.getOrCreate('three', async () => 'ok')).toBe('ok')
  })

  test('one client at its admission cap does not starve another client', async () => {
    const budget = new ResponseReceiptBudget()
    const busyClient = new ResponseReceiptCache(() => 'busy', budget)
    const otherClient = new ResponseReceiptCache(() => 'busy', budget)
    const pending = new Promise<string>(() => {})

    for (let index = 0; index < RESPONSE_RECEIPT_MAX_IN_FLIGHT; index++) {
      busyClient.getOrCreate(`busy-${index}`, () => pending)
    }

    expect(await otherClient.getOrCreate('routine-read', async () => 'ok')).toBe('ok')
  })

  test('shares settled-byte retention across client caches', async () => {
    const budget = new ResponseReceiptBudget(4, 100)
    const firstClient = new ResponseReceiptCache(() => 'busy', budget)
    const secondClient = new ResponseReceiptCache(() => 'busy', budget)

    await firstClient.getOrCreate('one', async () => 'x'.repeat(20))
    await Promise.resolve()
    await secondClient.getOrCreate('two', async () => 'y'.repeat(20))
    await Promise.resolve()

    expect(firstClient.stats().entries).toBe(1)
    expect(secondClient.stats().entries).toBe(0)
    expect(budget.stats()).toEqual({ inFlight: 0, settledBytes: 56 })
    firstClient.close()
    expect(budget.stats()).toEqual({ inFlight: 0, settledBytes: 0 })
  })

  test('returns shared bytes when the per-client entry cap evicts receipts', async () => {
    const budget = new ResponseReceiptBudget(4, 100_000)
    const cache = new ResponseReceiptCache(() => 'busy', budget)
    for (let index = 0; index < 101; index++) {
      await cache.getOrCreate(`request-${index}`, async () => 'ok')
      await Promise.resolve()
    }

    expect(cache.stats().entries).toBe(100)
    expect(budget.stats()).toEqual({ inFlight: 0, settledBytes: 2_000 })
  })
})

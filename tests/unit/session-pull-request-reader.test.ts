import { expect, test } from 'bun:test'
import { SessionPullRequestReader } from '@solus/client-core/session-pull-request-reader'
import type { SessionPullRequestsBySession } from '@solus/contracts/session-pull-requests'

test('adjacent session changes share one host request, including repeated changes to one session', async () => {
  let flush!: () => void
  const calls: Array<string[] | undefined> = []
  const answer: SessionPullRequestsBySession = { first: [], second: [] }
  const reader = new SessionPullRequestReader({
    sessionPullRequestsList: async (sessionIds) => { calls.push(sessionIds); return answer },
  }, (read) => { flush = read })
  const first = reader.read('first')
  expect(reader.read('first')).toBe(first)
  // Separate transport deliveries still fit within the scheduled batch.
  await Promise.resolve()
  const second = reader.read('second')
  expect(calls).toEqual([])
  flush()
  expect(await Promise.all([first, second])).toEqual([answer, answer])
  expect(calls).toEqual([['first', 'second']])
})

test('a change during a read waits, then reads again instead of accepting the earlier state', async () => {
  let flush!: () => void
  let finish!: (answer: SessionPullRequestsBySession) => void
  const calls: Array<string[] | undefined> = []
  const reader = new SessionPullRequestReader({
    sessionPullRequestsList: (sessionIds) => {
      calls.push(sessionIds)
      return calls.length === 1
        ? new Promise<SessionPullRequestsBySession>((resolve) => { finish = resolve })
        : Promise.resolve({ changed: [] })
    },
  }, (read) => { flush = read })
  const before = reader.read('changed')
  flush()
  await Promise.resolve()
  const after = reader.read('changed')
  flush()
  expect(calls).toHaveLength(1)
  finish({})
  expect(await before).toEqual({})
  expect(await after).toEqual({ changed: [] })
  expect(calls).toEqual([['changed'], ['changed']])
})

test('a failed batch keeps later changes retryable', async () => {
  let flush!: () => void
  let calls = 0
  const reader = new SessionPullRequestReader({
    sessionPullRequestsList: async () => {
      if (++calls === 1) throw new Error('Disconnected')
      return {}
    },
  }, (read) => { flush = read })
  const failed = reader.read('session')
  const failure = failed.catch((error: Error) => error)
  flush()
  expect(await failure).toEqual(new Error('Disconnected'))
  const retry = reader.read('session')
  flush()
  expect(await retry).toEqual({})
  expect(calls).toBe(2)
})

test('different host readers do not share a batch', async () => {
  const calls: string[] = []
  const readers = ['host-a', 'host-b'].map((host) => new SessionPullRequestReader({
    sessionPullRequestsList: async () => { calls.push(host); return {} },
  }, (read) => { read() }))
  await Promise.all(readers.map((reader) => reader.read('session')))
  expect(calls).toEqual(['host-a', 'host-b'])
})

test('a synchronous transport failure rejects the batch and does not block retries', async () => {
  let flush!: () => void
  let calls = 0
  const reader = new SessionPullRequestReader({
    sessionPullRequestsList: () => {
      if (++calls === 1) throw new Error('Transport unavailable')
      return Promise.resolve({})
    },
  }, (read) => { flush = read })
  const failure = reader.read('session').catch((error: Error) => error)
  flush()
  expect(await failure).toEqual(new Error('Transport unavailable'))
  const retry = reader.read('session')
  flush()
  expect(await retry).toEqual({})
})

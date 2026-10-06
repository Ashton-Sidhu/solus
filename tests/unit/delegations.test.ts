import { afterEach, describe, expect, test } from 'bun:test'
import { Delegations } from '@solus/server/sync/delegations'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((finish) => { resolve = finish })
  return { promise, resolve }
}

function exchange() {
  return { started: deferred<void>(), answer: deferred<Response>() }
}

const instances: Delegations[] = []
afterEach(() => { for (const instance of instances.splice(0)) instance.clear() })

function world(exchanges: ReturnType<typeof exchange>[], personToken: () => string | Promise<string | null> = () => 'person-token') {
  let requests = 0
  let subjects = 0
  const delegations = new Delegations({
    link: () => ({ hostId: 'host', issuer: 'https://account.test', jwksUrl: 'https://account.test/jwks', directoryUrl: 'https://account.test', hostname: 'host.test', proxiedPort: 1, connectionGeneration: 1, apiUrl: 'https://api.test' }),
    client: () => ({ clientId: 'host-client', clientSecret: 'secret' }),
    personToken: () => { subjects++; return personToken() },
    onRevoked: () => {},
    fetchImpl: async () => {
      const request = exchanges[requests++]
      if (!request) throw new Error('Unexpected token exchange')
      request.started.resolve()
      return request.answer.promise
    },
  })
  delegations.clear()
  instances.push(delegations)
  return { delegations, requests: () => requests, subjects: () => subjects }
}

const answer = (token = 'access') => Response.json({ access_token: token, refresh_token: `refresh-${token}`, expires_in: 300 })
const outcome = (pending: Promise<void>) => pending.then(() => null, (error: Error) => error)

describe('delegation creation', () => {
  test('concurrent callers share one subject lookup and exchange, then reuse the held delegation', async () => {
    const request = exchange()
    const w = world([request])
    const callers = Array.from({ length: 10 }, () => w.delegations.ensure('user', 'org'))
    await request.started.promise
    expect(w.subjects()).toBe(1)
    expect(w.requests()).toBe(1)
    request.answer.resolve(answer())
    await Promise.all(callers)
    expect(await w.delegations.accessToken('user', 'org')).toBe('access')
    await w.delegations.ensure('user', 'org')
    expect(w.requests()).toBe(1)
  })

  test('different users and organizations can exchange independently', async () => {
    const requests = [exchange(), exchange(), exchange()]
    const w = world(requests)
    const callers = [w.delegations.ensure('a', 'org'), w.delegations.ensure('b', 'org'), w.delegations.ensure('a', 'other')]
    await Promise.all(requests.map((request) => request.started.promise))
    expect(w.requests()).toBe(3)
    for (const request of requests) request.answer.resolve(answer())
    await Promise.all(callers)
    expect(w.delegations.holders()).toHaveLength(3)
  })

  test('a failed exchange rejects all waiters and allows a later retry', async () => {
    const first = exchange()
    const retry = exchange()
    const w = world([first, retry])
    const callers = [outcome(w.delegations.ensure('user', 'org')), outcome(w.delegations.ensure('user', 'org'))]
    await first.started.promise
    first.answer.resolve(Response.json({ error: 'unavailable' }, { status: 503 }))
    const errors = await Promise.all(callers)
    expect(errors[0]).toBeInstanceOf(Error)
    expect(errors[1]).toBe(errors[0])
    expect(w.delegations.has('user', 'org')).toBe(false)
    const pending = w.delegations.ensure('user', 'org')
    await retry.started.promise
    retry.answer.resolve(answer())
    await pending
    expect(w.requests()).toBe(2)
  })

  test('clearing rejects a late response without deleting a replacement exchange', async () => {
    const old = exchange()
    const replacement = exchange()
    const w = world([old, replacement])
    const discarded = outcome(w.delegations.ensure('user', 'org'))
    await old.started.promise
    w.delegations.clear()
    const pending = w.delegations.ensure('user', 'org')
    await replacement.started.promise
    old.answer.resolve(answer('old'))
    expect(await discarded).toBeInstanceOf(Error)
    expect(w.delegations.has('user', 'org')).toBe(false)
    const joined = w.delegations.ensure('user', 'org')
    expect(w.subjects()).toBe(2)
    replacement.answer.resolve(answer('new'))
    await Promise.all([pending, joined])
    expect(await w.delegations.accessToken('user', 'org')).toBe('new')
    expect(w.requests()).toBe(2)
  })

  test('forgetting an unstored delegation discards its exchange while another key completes', async () => {
    const forgotten = exchange()
    const other = exchange()
    const w = world([forgotten, other])
    const discarded = outcome(w.delegations.ensure('user', 'org'))
    const pending = w.delegations.ensure('other', 'org')
    await Promise.all([forgotten.started.promise, other.started.promise])
    w.delegations.forget('user', 'org')
    forgotten.answer.resolve(answer())
    other.answer.resolve(answer())
    expect(await discarded).toBeInstanceOf(Error)
    await pending
    expect(w.delegations.has('user', 'org')).toBe(false)
    expect(w.delegations.has('other', 'org')).toBe(true)
  })

  test('clearing during subject lookup prevents the exchange from starting', async () => {
    const subject = deferred<string | null>()
    const w = world([], () => subject.promise)
    const discarded = outcome(w.delegations.ensure('user', 'org'))
    w.delegations.clear()
    subject.resolve('person-token')
    expect(await discarded).toBeInstanceOf(Error)
    expect(w.requests()).toBe(0)
    expect(w.delegations.has('user', 'org')).toBe(false)
  })

  test('a missing subject token can be retried after sign-in', async () => {
    let token: string | null = null
    const request = exchange()
    const w = world([request], () => Promise.resolve(token))
    expect(await outcome(w.delegations.ensure('user', 'org'))).toBeInstanceOf(Error)
    token = 'person-token'
    const pending = w.delegations.ensure('user', 'org')
    await request.started.promise
    request.answer.resolve(answer())
    await pending
    expect(w.subjects()).toBe(2)
    expect(w.requests()).toBe(1)
  })
})

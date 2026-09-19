import { describe, expect, expectTypeOf, test } from 'bun:test'
import {
  APIUserAbortError, AuthenticationError, RateLimitError, TypeSafeError,
  choice, createTypeSafe, noul, score,
  type SystemOneResult,
} from '../../packages/server/src/typesafe/index'

const questions = {
  category: choice('What is the request about?', { bug: null, other: null }),
  blocked: noul('Is the user blocked?'),
  severity: score('How severe is the issue?', ['No failure', 'Work is blocked']),
}
const response = {
  model: 'test-model',
  answers: {
    category: { type: 'choice', choice: 'bug', confidence: 0.8, probabilities: { bug: 0.9, other: 0.1 } },
    blocked: { type: 'noul', noul: 0.9 },
    severity: { type: 'score', score: 0.9, confidence: 0.8, legend: { 0: 'No failure', 1: 'Work is blocked' }, probabilities: { 0: 0.1, 1: 0.9 } },
  },
  usage: { input_tokens: 20, output_tokens: 5 },
} satisfies SystemOneResult<typeof questions>

describe('TypeSafe server interface', () => {
  test('batches typed questions and preserves probabilities, usage, and request metadata', async () => {
    const requests: Request[] = []
    const client = createTypeSafe({
      apiKey: 'test-key', baseURL: 'https://typesafe.test', defaultModel: 'configured-model',
      fetch: async (input, init) => {
        requests.push(new Request(input, init))
        return Response.json(response, { headers: { 'x-typesafe-request-id': 'request-1' } })
      },
    })
    const result = await client.systemOne({ state: { message: 'It crashes' }, questions }).withResponse()
    expectTypeOf(result.data.answers.category.choice).toEqualTypeOf<'bug' | 'other'>()
    expectTypeOf(result.data.answers.blocked.noul).toEqualTypeOf<number>()
    expectTypeOf(result.data.answers.severity.score).toEqualTypeOf<number>()
    expect(result.data).toEqual(response)
    expect(result.requestId).toBe('request-1')
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('https://typesafe.test/v1/systemone')
    expect(requests[0].headers.get('authorization')).toBe('Bearer test-key')
    expect(await requests[0].json()).toEqual({ state: { message: 'It crashes' }, questions, model: 'configured-model' })
    await client.systemOne({ state: null, questions, model: 'override-model' })
    expect(await requests[1].json()).toMatchObject({ model: 'override-model' })
  })

  test('discovers models through the same authenticated client', async () => {
    const models = [{ name: 'test-model', description: 'Test', release_date: '2026-09-17' }]
    const client = createTypeSafe({
      apiKey: 'test-key', baseURL: 'https://typesafe.test',
      fetch: async (input, init) => {
        expect(input).toBe('https://typesafe.test/v1/models')
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-key')
        return Response.json({ models })
      },
    })
    expect(await client.models.list()).toEqual(models)
  })

  test('rejects missing credentials and empty questions without network calls', () => {
    expect(() => createTypeSafe({ apiKey: '' })).toThrow(TypeSafeError)
    const client = createTypeSafe({ apiKey: 'test-key', fetch: async () => { throw new Error('Unexpected network call') } })
    expect(() => client.systemOne({ state: null, questions: {} })).toThrow(TypeSafeError)
  })

  test('retries transient errors twice and preserves the final typed error', async () => {
    let attempts = 0
    const client = createTypeSafe({
      apiKey: 'test-key', retry: { backoffInitialMs: 0, respectRetryAfter: false },
      fetch: async () => {
        attempts++
        return Response.json({ error: 'Rate limited' }, { status: 429 })
      },
    })
    await expect(client.systemOne({ state: null, questions }).then(value => value)).rejects.toBeInstanceOf(RateLimitError)
    expect(attempts).toBe(3)
    attempts = 0
    await expect(client.models.list({ retry: { maxRetries: 0 } }).then(value => value)).rejects.toBeInstanceOf(RateLimitError)
    expect(attempts).toBe(1)
  })

  test('does not retry authentication failures or turn them into judgments', async () => {
    let attempts = 0
    const client = createTypeSafe({ apiKey: 'test-key', fetch: async () => {
      attempts++
      return Response.json({ error: 'Invalid key' }, { status: 401 })
    } })
    await expect(client.systemOne({ state: null, questions }).then(value => value)).rejects.toBeInstanceOf(AuthenticationError)
    expect(attempts).toBe(1)
  })

  test('passes cancellation to the transport and does not retry', async () => {
    let attempts = 0
    const client = createTypeSafe({ apiKey: 'test-key', fetch: async (_input, init) => {
      attempts++
      expect(init?.signal?.aborted).toBe(true)
      init?.signal?.throwIfAborted()
      return Response.json(response)
    } })
    const signal = AbortSignal.abort()
    await expect(client.systemOne({ state: null, questions }, { signal }).then(value => value)).rejects.toBeInstanceOf(APIUserAbortError)
    expect(attempts).toBe(1)
  })
})

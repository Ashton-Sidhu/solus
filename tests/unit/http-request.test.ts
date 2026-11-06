import { describe, expect, test } from 'bun:test'
import { httpClient, type HttpTokenSource } from '@solus/client-core/http-request'

interface Sent {
  url: string
  init: RequestInit
}

function recordingFetch(answers: Array<Response | Error>): { fetch: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = []
  const impl = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    sent.push({ url: String(input), init })
    const answer = answers.shift()
    if (!answer) throw new Error('no answer queued')
    if (answer instanceof Error) throw answer
    return answer
  }
  return { fetch: impl as typeof fetch, sent }
}

/** A session that gives `tokens` in order and records each `refused` it was told. */
function tokenSource(tokens: Array<string | null>): { token: HttpTokenSource; refused: Array<string | undefined> } {
  const refused: Array<string | undefined> = []
  return {
    refused,
    token: async (options) => {
      refused.push(options.refused)
      return tokens.shift() ?? null
    },
  }
}

describe('httpClient', () => {
  test('sends the bearer token, JSON body, and headers every Solus request needs', async () => {
    const { fetch, sent } = recordingFetch([new Response('{}', { status: 200 })])
    const client = httpClient({ baseUrl: 'https://solus.example/', token: tokenSource(['t1']).token, fetch })

    const result = await client.request('/v1/hosts', { method: 'POST', body: { label: 'a' } })

    expect(result.kind).toBe('response')
    expect(sent[0]!.url).toBe('https://solus.example/v1/hosts')
    const headers = new Headers(sent[0]!.init.headers)
    expect(headers.get('authorization')).toBe('Bearer t1')
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('accept')).toBe('application/json')
    expect(sent[0]!.init.body).toBe('{"label":"a"}')
    expect(sent[0]!.init.credentials).toBe('omit')
    expect(sent[0]!.init.cache).toBe('no-store')
  })

  test('a 401 tells the source which token was refused and retries once with the new one', async () => {
    const { fetch, sent } = recordingFetch([new Response(null, { status: 401 }), new Response('{}', { status: 200 })])
    const source = tokenSource(['old', 'new'])
    const client = httpClient({ baseUrl: 'https://solus.example', token: source.token, fetch })

    const result = await client.request('/v1/account')

    expect(result.kind === 'response' && result.response.status).toBe(200)
    expect(source.refused).toEqual([undefined, 'old'])
    expect(new Headers(sent[1]!.init.headers).get('authorization')).toBe('Bearer new')
  })

  test('a second 401 goes back to the caller, so its decoder can read it as signed out', async () => {
    const { fetch, sent } = recordingFetch([new Response(null, { status: 401 }), new Response(null, { status: 401 })])
    const client = httpClient({ baseUrl: 'https://solus.example', token: tokenSource(['old', 'new']).token, fetch })

    const result = await client.request('/v1/account')

    expect(result.kind === 'response' && result.response.status).toBe(401)
    expect(sent).toHaveLength(2)
  })

  test('a 401 with no other token to give is not sent again', async () => {
    const { fetch, sent } = recordingFetch([new Response(null, { status: 401 })])
    const client = httpClient({ baseUrl: 'https://solus.example', token: tokenSource(['old', 'old']).token, fetch })

    const result = await client.request('/v1/account')

    expect(result.kind === 'response' && result.response.status).toBe(401)
    expect(sent).toHaveLength(1)
  })

  test('no sign-in sends nothing', async () => {
    const { fetch, sent } = recordingFetch([])
    const client = httpClient({ baseUrl: 'https://solus.example', token: tokenSource([null]).token, fetch })

    expect(await client.request('/v1/account')).toEqual({ kind: 'signed-out' })
    expect(sent).toHaveLength(0)
  })

  test('a network failure is unreachable, not an error the caller must catch', async () => {
    const { fetch } = recordingFetch([new TypeError('fetch failed')])
    const client = httpClient({ baseUrl: 'https://solus.example', token: tokenSource(['t']).token, fetch })

    expect(await client.request('/v1/account')).toEqual({ kind: 'unreachable' })
  })

  test('a request that takes longer than the timeout is unreachable', async () => {
    const hanging = ((_input: RequestInfo | URL, init: RequestInit = {}) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
    })) as typeof fetch
    const client = httpClient({ baseUrl: 'https://solus.example', token: tokenSource(['t']).token, timeoutMs: 10, fetch: hanging })

    expect(await client.request('/v1/account')).toEqual({ kind: 'unreachable' })
  })
})

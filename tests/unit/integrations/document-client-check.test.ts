import { describe, expect, test } from 'bun:test'
import { DocumentClientCheck, documentClientAnswer } from '@solus/server/integrations/document-client-check'

const AUTHORIZE = 'https://auth.example.com/oauth/authorize?client_id=https%3A%2F%2Fsolus.sh%2Foauth%2Fclient-metadata.json'
const CALLBACK = 'http://127.0.0.1:51790/callback'

describe('the answer of an authorization server to Solus\'s document', () => {
  // The answers are those of real servers in November 2026.
  const cases: Array<[string, number, string | null, ReturnType<typeof documentClientAnswer>]> = [
    ['Lovable shows "Client not supported"', 400, null, 'refused'],
    ['a server answers invalid_client', 401, null, 'refused'],
    ['Descope sends the browser to its error page', 303, 'https://api.descope.com/login/error?error=invalid_client%3A+Client+ID+Metadata+Document+is+not+hosted+on+a+trusted+domain', 'refused'],
    ['tray.ai sends the browser to its error page', 302, 'https://id.tray.ai/oauth2/error?error_code=invalid_client_id', 'refused'],
    ['a server returns to the callback with unauthorized_client', 302, `${CALLBACK}?error=unauthorized_client&state=s`, 'refused'],
    ['a server shows its login page', 200, null, 'accepted'],
    ['a server sends the browser to its login page', 302, 'https://symbol.chat/auth/mcp-authorize?client_id=x', 'accepted'],
    ['a relative redirect to the login page', 302, '/login?next=%2Foauth%2Fauthorize', 'accepted'],
    ['a scope error at the callback is not about the client', 302, `${CALLBACK}?error=invalid_scope&state=s`, 'unclear'],
    ['a rate limit', 429, null, 'unclear'],
    ['a bot wall', 403, null, 'unclear'],
    ['a server error', 500, null, 'unclear'],
    ['a redirect with no place', 302, null, 'unclear'],
  ]
  for (const [name, status, location, answer] of cases) {
    test(`${name}: ${answer}`, () => {
      // WHY: only a clear refusal moves the sign-in off the document; an unclear answer keeps today's behavior.
      expect(documentClientAnswer(status, location, AUTHORIZE, CALLBACK)).toBe(answer)
    })
  }
})

describe('DocumentClientCheck', () => {
  function checking(answer: () => Response | Promise<Response>) {
    let now = 0
    const asked: string[] = []
    const fetchImpl: typeof fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      asked.push(String(input))
      // No cookies and no redirect followed: the server's answer, not a page after a login.
      expect(init?.redirect).toBe('manual')
      return answer()
    }, { preconnect: fetch.preconnect })
    const check = new DocumentClientCheck({ fetch: fetchImpl, now: () => now })
    return { check, asked, later: (ms: number) => { now += ms } }
  }

  test('a refusal is kept a day for the issuer, then asked again', async () => {
    const { check, asked, later } = checking(() => new Response('no', { status: 400 }))
    expect(await check.refuses('https://lovable.dev/oauth', AUTHORIZE, CALLBACK)).toBe(true)
    later(60 * 60 * 1000)
    expect(await check.refuses('https://lovable.dev/oauth', AUTHORIZE, CALLBACK)).toBe(true)
    expect(asked.length).toBe(1)
    // WHY: a server that later trusts Solus's domain gets the document again.
    later(24 * 60 * 60 * 1000)
    await check.refuses('https://lovable.dev/oauth', AUTHORIZE, CALLBACK)
    expect(asked.length).toBe(2)
  })

  test('an unclear answer is not kept and is not a refusal', async () => {
    const { check, asked } = checking(() => { throw new TypeError('fetch failed') })
    expect(await check.refuses('https://auth.example.com', AUTHORIZE, CALLBACK)).toBe(false)
    expect(await check.refuses('https://auth.example.com', AUTHORIZE, CALLBACK)).toBe(false)
    expect(asked.length).toBe(2)
  })
})

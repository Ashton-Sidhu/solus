import { describe, expect, test } from 'bun:test'
import { loopbackAuthorizer } from '@solus/desktop-main/account/loopback-authorizer'

// The desktop's browser step (RFC 8252 §7.3): a real one-shot server on 127.0.0.1.
// Only one GET /callback with this sign-in's state finishes it; anything else is
// refused and the server keeps waiting. The server closes when the step ends.

function authorizeUrl(state: string): URL {
  const url = new URL('https://account.test/api/auth/oauth2/authorize')
  url.searchParams.set('state', state)
  return url
}

async function isClosed(redirectUri: string): Promise<boolean> {
  try {
    await fetch(redirectUri, { signal: AbortSignal.timeout(1_000) })
    return false
  } catch {
    return true
  }
}

describe('loopback authorizer', () => {
  test('listens on a free loopback port and answers the callback with this state', async () => {
    const opened: string[] = []
    const authorization = await loopbackAuthorizer({ openExternal: async (url) => { opened.push(url) } }).start()
    expect(authorization.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    const done = authorization.complete(authorizeUrl('state-1'))
    await Promise.resolve()
    expect(opened).toEqual([authorizeUrl('state-1').toString()])

    // A forged state and another path are refused, and the step goes on.
    expect((await fetch(`${authorization.redirectUri}?code=x&state=forged`)).status).toBe(404)
    expect((await fetch(authorization.redirectUri.replace('/callback', '/other'))).status).toBe(404)

    const page = await fetch(`${authorization.redirectUri}?code=abc&state=state-1`)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('You can close this tab')
    const callback = await done
    expect(callback?.searchParams.get('code')).toBe('abc')
    expect(await isClosed(authorization.redirectUri)).toBe(true)
  })

  test('cancel ends the step with no callback and closes the server', async () => {
    const authorization = await loopbackAuthorizer({ openExternal: async () => {} }).start()
    const done = authorization.complete(authorizeUrl('state-2'))
    authorization.cancel()
    expect(await done).toBeNull()
    expect(await isClosed(authorization.redirectUri)).toBe(true)
  })

  test('the step ends with no callback when the person does not finish in time', async () => {
    const authorization = await loopbackAuthorizer({ openExternal: async () => {}, timeoutMs: 20 }).start()
    expect(await authorization.complete(authorizeUrl('state-3'))).toBeNull()
  })

  test('a browser that cannot open ends the step', async () => {
    const authorization = await loopbackAuthorizer({ openExternal: async () => { throw new Error('no browser') } }).start()
    expect(await authorization.complete(authorizeUrl('state-4'))).toBeNull()
  })
})

import { describe, expect, test } from 'bun:test'
import {
  requestDeviceCode,
  waitForDeviceApproval,
  type DeviceCodeGrant,
  type DeviceAuthorizationDeps,
} from '@solus/client-core/device-authorization'

// The device flow is how a person signs the server CLI in (ADR 0001 §2.2 rule 1). These
// tests pin the RFC 8628 behaviours that decide whether that path ends well: polling
// obeys the website's interval, `slow_down` backs off, every verdict is terminal, and
// approval gives OAuth tokens — never a session token.

const ORIGIN = 'https://cloud.test'
const CLIENT_ID = 'solus-test'
const TOKENS = { access_token: 'at', expires_in: 300, refresh_token: 'rt', id_token: 'h.p.s' }

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function grant(overrides: Partial<DeviceCodeGrant> = {}): DeviceCodeGrant {
  return {
    deviceCode: 'device-1',
    userCode: 'BCDFGHJK',
    verificationUrl: `${ORIGIN}/device?user_code=BCDFGHJK`,
    expiresAt: 10_000_000,
    intervalSeconds: 5,
    clientId: CLIENT_ID,
    ...overrides,
  }
}

function deps(
  answers: Array<Response | Error>,
  options: { now?: () => number } = {},
): Omit<DeviceAuthorizationDeps, 'clientId'> & { sleeps: number[]; calls: number } {
  const state = { sleeps: [] as number[], calls: 0 }
  return {
    cloudOrigin: ORIGIN,
    now: options.now ?? (() => 0),
    sleep: async (ms) => {
      state.sleeps.push(ms)
    },
    fetch: async () => {
      const answer = answers[state.calls++] ?? new Error('no more answers')
      if (answer instanceof Error) throw answer
      return answer
    },
    get sleeps() {
      return state.sleeps
    },
    get calls() {
      return state.calls
    },
  }
}

describe('requestDeviceCode', () => {
  test('sends the registered client id and maps the response to a grant with an absolute expiry', async () => {
    let sentBody = ''
    const d: Pick<DeviceAuthorizationDeps, 'cloudOrigin' | 'clientId' | 'fetch' | 'now'> = {
      cloudOrigin: ORIGIN,
      clientId: CLIENT_ID,
      now: () => 1_000,
      fetch: async (_url, init) => {
        sentBody = String(init?.body)
        return jsonResponse(200, {
          device_code: 'dc',
          user_code: 'BCDFGHJK',
          verification_uri: `${ORIGIN}/device`,
          verification_uri_complete: `${ORIGIN}/device?user_code=BCDFGHJK`,
          expires_in: 900,
          interval: 5,
        })
      },
    }
    const result = await requestDeviceCode(d)
    expect(JSON.parse(sentBody)).toEqual({ client_id: CLIENT_ID, scope: 'openid profile email offline_access' })
    expect(result).toEqual({
      deviceCode: 'dc',
      userCode: 'BCDFGHJK',
      verificationUrl: `${ORIGIN}/device?user_code=BCDFGHJK`,
      expiresAt: 901_000,
      intervalSeconds: 5,
      clientId: CLIENT_ID,
    })
  })
})

describe('waitForApproval', () => {
  test('waits the website\'s interval before each poll and returns the OAuth tokens when approved', async () => {
    const d = deps([
      jsonResponse(400, { error: 'authorization_pending' }),
      jsonResponse(200, TOKENS),
    ])
    const result = await waitForDeviceApproval(grant(), d, new AbortController().signal)
    expect(result).toEqual({ end: 'approved', tokens: TOKENS })
    expect(d.sleeps).toEqual([5000, 5000])
  })

  test('polls the OAuth token endpoint with the device-code grant, form encoded', async () => {
    const sent: Array<{ url: string; body: string }> = []
    const d = deps([])
    d.fetch = async (url, init) => {
      sent.push({ url: String(url), body: String(init?.body) })
      return jsonResponse(200, TOKENS)
    }
    await waitForDeviceApproval(grant(), d, new AbortController().signal)
    expect(sent[0]!.url).toBe(`${ORIGIN}/api/auth/oauth2/token`)
    expect(Object.fromEntries(new URLSearchParams(sent[0]!.body))).toEqual({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: 'device-1',
      client_id: CLIENT_ID,
    })
  })

  test('an approval without a refresh token or ID token is an error: a session token is not a sign-in', async () => {
    const d = deps([jsonResponse(200, { access_token: 'session-token' })])
    expect(await waitForDeviceApproval(grant(), d, new AbortController().signal)).toMatchObject({ end: 'error' })
  })

  test('slow_down adds five seconds to every later poll, per RFC 8628', async () => {
    const d = deps([
      jsonResponse(400, { error: 'slow_down' }),
      jsonResponse(400, { error: 'authorization_pending' }),
      jsonResponse(200, TOKENS),
    ])
    await waitForDeviceApproval(grant(), d, new AbortController().signal)
    expect(d.sleeps).toEqual([5000, 10000, 10000])
  })

  test('denied and expired are terminal verdicts', async () => {
    expect(await waitForDeviceApproval(grant(), deps([jsonResponse(400, { error: 'access_denied' })]), new AbortController().signal)).toMatchObject({ end: 'denied' })
    expect(await waitForDeviceApproval(grant(), deps([jsonResponse(400, { error: 'expired_token' })]), new AbortController().signal)).toMatchObject({ end: 'expired' })
  })

  test('a local clock past the expiry ends the attempt without another request', async () => {
    const d = deps([], { now: () => 10_000_001 })
    const result = await waitForDeviceApproval(grant(), d, new AbortController().signal)
    expect(result).toMatchObject({ end: 'expired' })
    expect(d.calls).toBe(0)
  })

  test('cancelling stops polling with a cancelled verdict, never an error', async () => {
    const abort = new AbortController()
    const d = deps([jsonResponse(400, { error: 'authorization_pending' }), jsonResponse(200, TOKENS)])
    d.sleep = async () => {
      abort.abort()
    }
    const result = await waitForDeviceApproval(grant(), d, abort.signal)
    expect(result).toMatchObject({ end: 'cancelled' })
    expect(d.calls).toBe(0)
  })

  test('a transient network failure retries instead of ending the attempt', async () => {
    const d = deps([new Error('offline'), jsonResponse(200, TOKENS)])
    const result = await waitForDeviceApproval(grant(), d, new AbortController().signal)
    expect(result).toMatchObject({ end: 'approved' })
    expect(d.calls).toBe(2)
  })
})

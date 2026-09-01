import { describe, expect, test } from 'bun:test'
import {
  DEVICE_CLIENT_ID,
  requestDeviceCode,
  waitForApproval,
  type DeviceCodeGrant,
  type DeviceSignInDeps,
} from '@solus/desktop-main/account/device-sign-in'

// The device flow is the one path a person takes to sign the desktop app in. These
// tests pin the RFC 8628 behaviours that decide whether that path ends well: polling
// obeys the website's interval, `slow_down` backs off, and every verdict is terminal.

const ORIGIN = 'https://cloud.test'

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
    ...overrides,
  }
}

function deps(
  answers: Array<Response | Error>,
  options: { now?: () => number } = {},
): DeviceSignInDeps & { sleeps: number[]; calls: number } {
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
    const d: Pick<DeviceSignInDeps, 'cloudOrigin' | 'fetch' | 'now'> = {
      cloudOrigin: ORIGIN,
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
    expect(JSON.parse(sentBody)).toEqual({ client_id: DEVICE_CLIENT_ID })
    expect(result).toEqual({
      deviceCode: 'dc',
      userCode: 'BCDFGHJK',
      verificationUrl: `${ORIGIN}/device?user_code=BCDFGHJK`,
      expiresAt: 901_000,
      intervalSeconds: 5,
    })
  })
})

describe('waitForApproval', () => {
  test('waits the website\'s interval before each poll and returns the token when approved', async () => {
    const d = deps([
      jsonResponse(400, { error: 'authorization_pending' }),
      jsonResponse(200, { access_token: 'session-token' }),
    ])
    const result = await waitForApproval(grant(), d, new AbortController().signal)
    expect(result).toEqual({ end: 'approved', sessionToken: 'session-token' })
    expect(d.sleeps).toEqual([5000, 5000])
  })

  test('slow_down adds five seconds to every later poll, per RFC 8628', async () => {
    const d = deps([
      jsonResponse(400, { error: 'slow_down' }),
      jsonResponse(400, { error: 'authorization_pending' }),
      jsonResponse(200, { access_token: 't' }),
    ])
    await waitForApproval(grant(), d, new AbortController().signal)
    expect(d.sleeps).toEqual([5000, 10000, 10000])
  })

  test('denied and expired are terminal verdicts', async () => {
    expect(await waitForApproval(grant(), deps([jsonResponse(400, { error: 'access_denied' })]), new AbortController().signal)).toMatchObject({ end: 'denied' })
    expect(await waitForApproval(grant(), deps([jsonResponse(400, { error: 'expired_token' })]), new AbortController().signal)).toMatchObject({ end: 'expired' })
  })

  test('a local clock past the expiry ends the attempt without another request', async () => {
    const d = deps([], { now: () => 10_000_001 })
    const result = await waitForApproval(grant(), d, new AbortController().signal)
    expect(result).toMatchObject({ end: 'expired' })
    expect(d.calls).toBe(0)
  })

  test('cancelling stops polling with a cancelled verdict, never an error', async () => {
    const abort = new AbortController()
    const d = deps([jsonResponse(400, { error: 'authorization_pending' }), jsonResponse(200, { access_token: 'late' })])
    d.sleep = async () => {
      abort.abort()
    }
    const result = await waitForApproval(grant(), d, abort.signal)
    expect(result).toMatchObject({ end: 'cancelled' })
    expect(d.calls).toBe(0)
  })

  test('a transient network failure retries instead of ending the attempt', async () => {
    const d = deps([new Error('offline'), jsonResponse(200, { access_token: 't' })])
    const result = await waitForApproval(grant(), d, new AbortController().signal)
    expect(result).toMatchObject({ end: 'approved' })
    expect(d.calls).toBe(2)
  })
})

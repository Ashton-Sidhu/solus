import { describe, expect, test } from 'bun:test'
import { ACCOUNT_AUDIENCE } from '@solus/contracts/uplink'
import { authorizeCli } from '../../apps/cli/src/lib/connect'
import { fakeAccountPlane, ISSUER } from './helpers/fake-account-plane'

// The server CLI signs in with the device grant (ADR 0001 §2.2 rule 1). The approved
// code gives OAuth tokens and a client grant, not a session token: the CLI reads its
// account with an access token for the account plane, and sign-out revokes the grant.

function cliPlane() {
  const plane = fakeAccountPlane({ clientId: 'solus-cli' })
  let polls = 0
  const fetchImpl = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    if (url.pathname === '/api/auth/device/code') {
      return Response.json({ device_code: 'dc', user_code: 'BCDFGHJK', verification_uri: `${ISSUER}/device`, verification_uri_complete: `${ISSUER}/device?user_code=BCDFGHJK`, expires_in: 900, interval: 5 })
    }
    const form = new URLSearchParams(typeof init?.body === 'string' ? init.body : '')
    if (form.get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code') {
      plane.calls.push({ path: url.pathname, form })
      return ++polls === 1 ? Response.json({ error: 'authorization_pending' }, { status: 400 }) : Response.json(plane.deviceTokens())
    }
    return plane.fetch(input, init)
  }
  return { plane, fetch: fetchImpl as typeof fetch }
}

describe('CLI device sign-in', () => {
  test('adopts the OAuth tokens and gives an account-plane access token by refresh', async () => {
    const { plane, fetch } = cliPlane()
    const stages: string[] = []
    const session = await authorizeCli(ISSUER, true, { deviceCode: () => {}, stage: (message) => stages.push(message) }, fetch, async () => {})
    expect(session.state()).toMatchObject({ kind: 'signed-in', identity: { email: 'ada@example.test' } })
    expect(stages).toEqual(['Account approved'])
    const token = await session.accessToken({ kind: 'account' })
    expect(token).toContain(ACCOUNT_AUDIENCE)
    const refresh = plane.calls.find((call) => call.form.get('grant_type') === 'refresh_token')!
    expect(refresh.form.get('client_id')).toBe('solus-cli')
    expect(refresh.form.get('resource')).toBe(ACCOUNT_AUDIENCE)
  })

  test('sign-out at the end of the command revokes the grant', async () => {
    const { plane, fetch } = cliPlane()
    const session = await authorizeCli(ISSUER, true, { deviceCode: () => {}, stage: () => {} }, fetch, async () => {})
    await session.accessToken({ kind: 'account' })
    await session.signOut()
    expect(plane.liveTokens()).toEqual([])
  })
})

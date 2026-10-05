import { describe, expect, test } from 'bun:test'
import { GRANT_RENEW_BEFORE_END_MS, keptGrantSource } from '@solus/client-core/server-connection'
import type { HostAccessTokenResponse } from '@solus/contracts/uplink'

const HOUR = 60 * 60 * 1000

function source(organization: { id: string | undefined } = { id: 'org_1' }) {
  let clock = 0
  const mints: Array<string | undefined> = []
  const grants = keptGrantSource(
    async (organizationId): Promise<HostAccessTokenResponse> => {
      mints.push(organizationId)
      return { accessToken: `token-${mints.length}`, hostId: 'host_1', expiresAt: clock + 8 * HOUR }
    },
    () => organization.id,
    () => clock,
  )
  return { grants, mints, advance: (ms: number) => { clock += ms } }
}

describe('kept grants', () => {
  test('a redial reuses the kept grant instead of asking the account site again', async () => {
    // WHY: every account-site call is a round trip before the socket can open.
    const { grants, mints, advance } = source()
    expect(await grants()).toBe('token-1')
    advance(HOUR)
    expect(await grants()).toBe('token-1')
    expect(mints.length).toBe(1)
  })

  test('a grant near its end is replaced, so a new socket is not closed soon after it opens', async () => {
    const { grants, advance } = source()
    await grants()
    advance(8 * HOUR - GRANT_RENEW_BEFORE_END_MS)
    expect(await grants()).toBe('token-2')
  })

  test('a refused grant is replaced when the transport asks for a fresh one', async () => {
    const { grants } = source()
    await grants()
    expect(await grants({ fresh: true })).toBe('token-2')
  })

  test('a window that moves to another organization gets a grant that names it', async () => {
    // WHY: a host shared with several organizations admits a connection by the organization its token names.
    const organization = { id: 'org_1' as string | undefined }
    const { grants, mints } = source(organization)
    await grants()
    organization.id = 'org_2'
    expect(await grants()).toBe('token-2')
    expect(mints).toEqual(['org_1', 'org_2'])
  })

  test('a dial and a record-API session that ask at once share one mint', async () => {
    const { grants, mints } = source()
    const [first, second] = await Promise.all([grants(), grants()])
    expect(first).toBe(second)
    expect(mints.length).toBe(1)
  })
})

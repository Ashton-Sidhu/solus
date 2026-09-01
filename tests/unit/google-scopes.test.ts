import { beforeAll, describe, expect, mock, test } from 'bun:test'
import {
  GOOGLE_DRIVE_FILE_SCOPE,
  GOOGLE_DRIVE_READONLY_SCOPE,
  hasGoogleDriveReadScope,
  missingGoogleScopes,
  parseGoogleScopes,
} from '@solus/contracts/google-auth'
import type { SecretStore } from '@solus/server/platform/secrets'

const records = new Map<string, unknown>()
const store: SecretStore = {
  loadJson: <T>(key: string) => (records.get(key) as T | undefined) ?? null,
  saveJson: (key: string, _path: string, value: unknown) => { records.set(key, value) },
  remove: (key: string) => { records.delete(key) },
  canSave: () => true,
}

mock.module('@solus/server/platform/secrets', () => ({ secretStore: () => store }))

let grantedGoogleScopes: typeof import('@solus/server/google/oauth')['grantedGoogleScopes']

beforeAll(async () => {
  ;({ grantedGoogleScopes } = await import('@solus/server/google/oauth'))
})

describe('Google scope drift', () => {
  test('a grant holding both scopes needs no reconnect', () => {
    const granted = [GOOGLE_DRIVE_FILE_SCOPE, GOOGLE_DRIVE_READONLY_SCOPE]
    expect(missingGoogleScopes(granted)).toEqual([])
    expect(hasGoogleDriveReadScope(granted)).toBe(true)
  })

  test('a publish-only grant is reported as missing the read scope', () => {
    // The whole point of persisting granted scopes: this grant still works for
    // publishing, so nothing else would reveal that it cannot read.
    expect(missingGoogleScopes([GOOGLE_DRIVE_FILE_SCOPE])).toEqual([GOOGLE_DRIVE_READONLY_SCOPE])
    expect(hasGoogleDriveReadScope([GOOGLE_DRIVE_FILE_SCOPE])).toBe(false)
  })

  test('an unknown grant is treated as holding nothing', () => {
    expect(missingGoogleScopes(undefined)).toEqual([GOOGLE_DRIVE_FILE_SCOPE, GOOGLE_DRIVE_READONLY_SCOPE])
  })

  test('Google states granted scopes space-separated', () => {
    expect(parseGoogleScopes(`${GOOGLE_DRIVE_FILE_SCOPE} ${GOOGLE_DRIVE_READONLY_SCOPE}`)).toEqual([
      GOOGLE_DRIVE_FILE_SCOPE,
      GOOGLE_DRIVE_READONLY_SCOPE,
    ])
    expect(parseGoogleScopes(undefined)).toEqual([])
  })
})

describe('grantedGoogleScopes', () => {
  test('reports what a grant stored before this field existed can only have held', () => {
    records.clear()
    // No `scopes` key: written by a build that asked for `drive.file` alone.
    records.set('google-oauth', { refreshToken: 'r', accessToken: 'a', expiresAt: Date.now() + 60_000 })
    expect(grantedGoogleScopes()).toEqual([GOOGLE_DRIVE_FILE_SCOPE])
    expect(missingGoogleScopes(grantedGoogleScopes() ?? undefined)).toEqual([GOOGLE_DRIVE_READONLY_SCOPE])
  })

  test('reports the recorded scopes when the grant has them', () => {
    records.clear()
    records.set('google-oauth', {
      refreshToken: 'r',
      accessToken: 'a',
      expiresAt: Date.now() + 60_000,
      scopes: [GOOGLE_DRIVE_FILE_SCOPE, GOOGLE_DRIVE_READONLY_SCOPE],
    })
    expect(missingGoogleScopes(grantedGoogleScopes() ?? undefined)).toEqual([])
  })

  test('is null when nothing is stored', () => {
    records.clear()
    expect(grantedGoogleScopes()).toBeNull()
  })
})

/**
 * The adapter reads the grant through `google/oauth`, so these replace that
 * module. `mock.module` is process-wide in bun, so it is installed here rather
 * than at file scope: the tests above exercise the real implementation.
 */
describe('Google Drive doc adapter status', () => {
  let scopes: string[] = []

  async function statusFrom(oauth: {
    configured: boolean
    token: string | null
    granted?: string[]
  }) {
    scopes = oauth.granted ?? []
    mock.module('@solus/server/google/oauth', () => ({
      isGoogleOAuthConfigured: () => oauth.configured,
      getAccessToken: async () => oauth.token,
      grantedGoogleScopes: () => scopes,
    }))
    const { GoogleDriveDocAdapter } = await import('@solus/server/docs/gdrive/adapter')
    return new GoogleDriveDocAdapter().status()
  }

  const statusWithScopes = (granted: string[]) =>
    statusFrom({ configured: true, token: 'token', granted })

  test('a signed-out connection is offered as something the user can sign in to', async () => {
    const status = await statusFrom({ configured: true, token: null })
    expect(status.connected).toBe(false)
    // The publish menu turns this into a route to Settings. Listing nothing at
    // all is what made a signed-out provider look unsupported.
    expect(status.connectable).toBe(true)
  })

  test('a build without an OAuth client offers no sign-in', async () => {
    const status = await statusFrom({ configured: false, token: null })
    expect(status.connected).toBe(false)
    // There is no client to authorize against, so a Connect route would lead
    // the user to a Settings row that cannot help either.
    expect(status.connectable).toBe(false)
    expect(status.reason).toContain('unavailable in this build')
  })

  test('a publish-only grant stays connected and names what it cannot reach', async () => {
    // Refusing the connection would break publishing, which this grant can do.
    // The missing reach has to be stated: search just returns fewer results and
    // read returns a 404 that reads like a deleted document.
    const status = await statusWithScopes([GOOGLE_DRIVE_FILE_SCOPE])
    expect(status.connected).toBe(true)
    expect(status.limitation).toContain('only see documents Solus created')
  })

  test('a grant with the read scope reports no limitation', async () => {
    const status = await statusWithScopes([GOOGLE_DRIVE_FILE_SCOPE, GOOGLE_DRIVE_READONLY_SCOPE])
    expect(status.connected).toBe(true)
    expect(status.limitation).toBeUndefined()
  })
})

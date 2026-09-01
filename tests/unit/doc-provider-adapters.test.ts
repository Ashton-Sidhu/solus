import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { SecretStore } from '@solus/server/platform/secrets'

/**
 * The document provider boundary: how a doc is addressed from a URL, and the
 * version guard that stands between a publish and someone else's edit.
 */

const records = new Map<string, unknown>()
const store: SecretStore = {
  // SAFETY: every record was written by this file's own saveJson, so the value
  // read back is the one the matching load expects.
  loadJson: <T>(key: string) => (records.get(key) as T | undefined) ?? null,
  saveJson: (key: string, _path: string, value: unknown) => { records.set(key, value) },
  remove: (key: string) => { records.delete(key) },
  canSave: () => true,
}

mock.module('@solus/server/platform/secrets', () => ({ secretStore: () => store }))
mock.module('@solus/server/atlassian/client-id', () => ({ ATLASSIAN_CLIENT_ID: 'test-client' }))
mock.module('@solus/server/atlassian/client-secret', () => ({ ATLASSIAN_CLIENT_SECRET: 'test-secret' }))

// The adapters are imported directly rather than through the registry: bun's
// module mocks are process-wide, and work-sync.test.ts stubs the registry for
// its own run. What is worth asserting lives in the adapters anyway — the
// registry only asks each one whether it owns a URL.
let confluence: InstanceType<typeof import('@solus/server/docs/confluence/adapter')['ConfluenceDocAdapter']>
let gdrive: InstanceType<typeof import('@solus/server/docs/gdrive/adapter')['GoogleDriveDocAdapter']>
let docTypes: typeof import('@solus/server/docs/types')

beforeAll(async () => {
  const { ConfluenceDocAdapter } = await import('@solus/server/docs/confluence/adapter')
  const { GoogleDriveDocAdapter } = await import('@solus/server/docs/gdrive/adapter')
  confluence = new ConfluenceDocAdapter()
  gdrive = new GoogleDriveDocAdapter()
  docTypes = await import('@solus/server/docs/types')
})

const CLOUD_ID = 'cloud-123'

function connectAtlassian(): void {
  records.set('atlassian-oauth', {
    siteUrl: 'https://acme.atlassian.net',
    cloudId: CLOUD_ID,
    products: ['confluence', 'jira'],
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresAt: Date.now() + 3_600_000,
    scopes: ['read:confluence-content.all', 'write:confluence-content'],
  })
}

beforeEach(() => {
  records.clear()
})

describe('resolveUrl', () => {
  test('addresses a Confluence page by the cloudId that survives a site rename', () => {
    connectAtlassian()
    const ref = confluence.resolveUrl('https://acme.atlassian.net/wiki/spaces/ENG/pages/98765/Spec')

    expect(ref?.externalId).toBe('98765')
    // The persisted key is cloudId-scoped, not hostname-scoped — every later
    // link and publish is built from it.
    expect(ref?.externalKey).toBe(`${CLOUD_ID}/ENG`)
  })

  test('refuses a Confluence URL from a site this connection does not reach', () => {
    connectAtlassian()
    expect(confluence.resolveUrl('https://other.atlassian.net/wiki/spaces/ENG/pages/1/X')).toBeNull()
  })

  test('addresses a Google Doc by its file id', () => {
    const ref = gdrive.resolveUrl('https://docs.google.com/document/d/abc_123-XYZ/edit?tab=t.0')

    expect(ref?.provider).toBe('gdrive')
    expect(ref?.externalId).toBe('abc_123-XYZ')
  })

  test('claims nothing for a URL no provider owns', () => {
    connectAtlassian()
    expect(confluence.resolveUrl('https://example.com/some/page')).toBeNull()
    expect(gdrive.resolveUrl('https://example.com/some/page')).toBeNull()
  })
})

describe('Confluence status', () => {
  test('a missing connection is offered as something the user can sign in to', async () => {
    const status = await confluence.status()
    expect(status.connected).toBe(false)
    // The publish menu turns this into a route to Settings; without it the row
    // would be a dead end and the provider would look unsupported.
    expect(status.connectable).toBe(true)
  })

  test('a site without a Confluence licence is not offered a sign-in', async () => {
    records.set('atlassian-oauth', {
      siteUrl: 'https://acme.atlassian.net',
      cloudId: CLOUD_ID,
      products: ['jira'],
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: Date.now() + 3_600_000,
      scopes: [],
    })
    const status = await confluence.status()
    expect(status.connected).toBe(false)
    // Signing in again reaches the same site and the same licence.
    expect(status.connectable).toBe(false)
    expect(status.reason).toContain('does not grant Confluence access')
  })
})

describe('Confluence refusals', () => {
  test('reads Confluence\'s own error dialect, not just Jira\'s, so a scope refusal names itself', async () => {
    connectAtlassian()
    const originalFetch = globalThis.fetch
    // The shape Confluence actually returns: `errors` is an array of problems,
    // where Jira's is a field→message record.
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ errors: [{ status: 401, code: 'UNAUTHORIZED', title: 'Unauthorized; scope does not match', detail: null }] }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch

    try {
      // A classic scope on a v2 endpoint fails exactly this way. Telling the
      // user only "HTTP 401" sends them to look at a working connection.
      await expect(confluence.destinations()).rejects.toThrow(/sign in again/i)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('Confluence update', () => {
  test('reports a conflict instead of overwriting a page that moved', async () => {
    connectAtlassian()

    const calls: string[] = []
    const originalFetch = globalThis.fetch

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      calls.push(url)
      return new Response(
        JSON.stringify({ id: '98765', title: 'Spec', version: { number: 7 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as typeof fetch

    try {
      const publish = confluence.update(
        { provider: 'confluence', externalKey: `${CLOUD_ID}/ENG`, externalId: '98765', url: '' },
        { markdown: '# New', expectedVersion: '5' },
      )
      await expect(publish).rejects.toBeInstanceOf(docTypes.DocVersionConflictError)
      // The guard has to fire before the write, or the overwrite already happened.
      expect(calls.some((url) => url.includes('/pages/98765') && !url.includes('body-format'))).toBe(true)
      expect(calls).toHaveLength(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('refuses a page whose link names a site other than the connected one', async () => {
    // WHY: page ids are per-site. Addressing a link written against site A while
    // site B is connected would resolve that id on B — a 404 at best, and at
    // worst an unrelated page read, or overwritten. The shared Atlassian
    // transport refuses before the request is made, which is why the doc layer
    // passes the link's cloudId rather than the connected one.
    connectAtlassian()

    const originalFetch = globalThis.fetch
    let reached = false
    globalThis.fetch = (async () => {
      reached = true
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    try {
      const read = confluence.read({
        provider: 'confluence',
        externalKey: 'a-different-site/ENG',
        externalId: '98765',
        url: '',
      })
      await expect(read).rejects.toBeInstanceOf(docTypes.DocProviderUnavailableError)
      expect(reached).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

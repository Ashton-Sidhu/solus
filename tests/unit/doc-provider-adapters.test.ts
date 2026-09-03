import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { SecretStore } from '@solus/server/platform/secrets'
import { serializeDiagramEmbed } from '@solus/contracts/diagram-embed'

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
    scopes: ['read:confluence-content.all', 'write:confluence-content', 'write:confluence-file'],
  })
}

beforeEach(() => {
  records.clear()
})

/** A PNG header is all the asset check and the size reader look at. */
function pngBase64(width: number, height: number): string {
  const header = Buffer.alloc(24)
  header.write('\x89PNG\r\n\x1a\n', 0, 'latin1')
  header.write('IHDR', 12, 'latin1')
  header.writeUInt32BE(width, 16)
  header.writeUInt32BE(height, 20)
  return header.toString('base64')
}

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

  test('a title a space already holds names the ways out, since Solus can take neither', async () => {
    // WHY: page titles are unique per space. Solus cannot adopt the existing
    // page — it may be someone else's — and has no scope to delete it, so
    // "HTTP 400" would leave the user with a refusal and no next step.
    connectAtlassian()
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify({ results: [{ id: '1', key: 'ENG', name: 'Engineering' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(
        JSON.stringify({ statusCode: 400, message: 'A page with this title already exists' }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      )
    }) as typeof fetch

    try {
      await expect(confluence.create('ENG', { title: 'Spec', markdown: '# Spec' })).rejects.toThrow(/Rename this document/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('reads the v1 dialect too, which is the only voice the attachment upload has', async () => {
    // WHY: attachment upload has no v2 endpoint. v1 answers with a flat
    // statusCode/message pair, and reading only the other two dialects
    // reported a refused diagram upload as a bare HTTP 401 with the reason
    // thrown away — which is exactly how it was first met in the wild.
    connectAtlassian()
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ statusCode: 401, message: 'Current user not permitted to use Confluence' }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch

    try {
      await expect(confluence.destinations()).rejects.toThrow(/not permitted to use Confluence/)
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

  test('puts a diagram on the page as an attachment before the body that points at it', async () => {
    // WHY: a Confluence page can only show an image it holds. Publishing the
    // body first would leave the page pointing at a picture that is not there,
    // and publishing nothing at all is how the embed used to become prose.
    connectAtlassian()

    const calls: { url: string; method: string; multipart: boolean }[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        multipart: init?.body instanceof FormData,
      })
      return new Response(
        JSON.stringify({ id: '98765', title: 'Spec', version: { number: 7 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as typeof fetch

    const workId = '018f0fd7-3684-426a-a0d4-4720572f99e6'

    try {
      await confluence.update(
        { provider: 'confluence', externalKey: `${CLOUD_ID}/ENG`, externalId: '98765', url: '' },
        {
          markdown: serializeDiagramEmbed({ workId, title: 'Target Architecture' }),
          diagramAssets: [{ workId, title: 'Target Architecture', mimeType: 'image/png', base64: pngBase64(800, 600) }],
        },
      )
    } finally {
      globalThis.fetch = originalFetch
    }

    const attachment = calls.findIndex((call) => call.url.includes('/child/attachment'))
    const write = calls.findIndex((call) => call.method === 'PUT' && !call.multipart)
    expect(attachment).toBeGreaterThanOrEqual(0)
    // Create-or-update by filename, so a republish replaces the picture rather
    // than being refused for a name the page already carries.
    expect(calls[attachment]!.method).toBe('PUT')
    expect(calls[attachment]!.multipart).toBe(true)
    expect(write).toBeGreaterThan(attachment)
  })

  test('refuses a diagram publish an older grant cannot carry, before creating the page', async () => {
    // WHY: a create writes the page before it can attach anything to it, so a
    // refusal after that point leaves a page whose title blocks every retry —
    // titles are unique per space and Solus cannot delete one.
    records.set('atlassian-oauth', {
      siteUrl: 'https://acme.atlassian.net',
      cloudId: CLOUD_ID,
      products: ['confluence'],
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: Date.now() + 3_600_000,
      scopes: ['read:page:confluence', 'write:page:confluence'],
    })

    const originalFetch = globalThis.fetch
    const written: string[] = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET') !== 'GET') written.push(String(input))
      return new Response(JSON.stringify({ results: [{ id: '1', key: 'ENG', name: 'Engineering' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch


    try {
      const publish = confluence.create('ENG', {
        title: 'Spec',
        markdown: 'body',
        diagramAssets: [{ workId: 'w1', title: 'Target Architecture', mimeType: 'image/png', base64: pngBase64(800, 600) }],
      })
      await expect(publish).rejects.toBeInstanceOf(docTypes.DocProviderUnavailableError)
      expect(written).toEqual([])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('refuses a diagram publish an older grant cannot carry, before writing anything', async () => {
    // WHY: the attachment scope is new. A grant made before it publishes prose
    // perfectly well, and would otherwise fail with a 403 after the page had
    // already been rewritten to point at pictures that never arrived.
    records.set('atlassian-oauth', {
      siteUrl: 'https://acme.atlassian.net',
      cloudId: CLOUD_ID,
      products: ['confluence'],
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: Date.now() + 3_600_000,
      scopes: ['read:page:confluence', 'write:page:confluence'],
    })

    const originalFetch = globalThis.fetch
    const written: string[] = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET') !== 'GET') written.push(String(input))
      return new Response(
        JSON.stringify({ id: '98765', title: 'Spec', version: { number: 7 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as typeof fetch

    try {
      const publish = confluence.update(
        { provider: 'confluence', externalKey: `${CLOUD_ID}/ENG`, externalId: '98765', url: '' },
        {
          markdown: 'body',
          diagramAssets: [{ workId: 'w1', title: 'Target Architecture', mimeType: 'image/png', base64: pngBase64(800, 600) }],
        },
      )
      await expect(publish).rejects.toBeInstanceOf(docTypes.DocProviderUnavailableError)
      expect(written).toEqual([])
      expect((await confluence.status()).limitation).toContain('sign in again')
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

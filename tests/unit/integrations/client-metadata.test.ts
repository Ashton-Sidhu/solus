import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { clientMetadataDocumentSchema, isClientIdUrl, namesItsUrl, SOLUS_CLIENT_ID_URL, SOLUS_CLIENT_METADATA } from '@solus/contracts/integrations/client-metadata-document'
import { DEFAULT_DESKTOP_SERVER_PORT, DEFAULT_SERVER_PORT } from '@solus/contracts/types'
import { INTEGRATION_OAUTH_CALLBACK_PATH } from '@solus/server/integrations/oauth'
import { INTEGRATION_OAUTH_LOOPBACK_URL } from '@solus/contracts/integrations/oauth-callback'
import { PublishedClientMetadata } from '@solus/server/integrations/client-metadata'
import { GET } from '../../../apps/site/src/routes/oauth/client-metadata.json/+server'

/**
 * Solus's Client ID Metadata Document (docs/plans/mcp-integrations.md §13.1,
 * draft-ietf-oauth-client-id-metadata-document, MCP 2026-07-28). Its URL is
 * Solus's client ID at every authorization server that reads such documents,
 * so what the site serves must be valid and name its own URL, and the host
 * must use it only after it read that published copy.
 */

const ROOT = join(import.meta.dir, '../../..')

/** What the site answers at the document's URL. */
async function served(): Promise<Response> {
  // SAFETY: the handler reads nothing of the request.
  return GET({} as never)
}

describe('the document the site serves', () => {
  test('is served as JSON with a cache header, at the path of its own client ID', async () => {
    const response = await served()
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(response.headers.get('cache-control')).toMatch(/max-age=\d+/)
    // WHY: an authorization server fetches the client ID itself; the route must live at that exact path on the site.
    const url = new URL(SOLUS_CLIENT_ID_URL)
    expect(url.origin).toBe('https://solus.sh')
    expect(existsSync(join(ROOT, 'apps/site/src/routes', url.pathname, '+server.ts'))).toBe(true)
  })

  test('is valid by the rules, and its client_id equals its URL', async () => {
    const document: unknown = await (await served()).json()
    const parsed = clientMetadataDocumentSchema.parse(document)
    // WHY (draft §4): a server that finds a different client_id refuses the client.
    expect(namesItsUrl(parsed, SOLUS_CLIENT_ID_URL)).toBe(true)
    expect(parsed).toEqual(SOLUS_CLIENT_METADATA)
    expect(document).toMatchObject({
      client_id: SOLUS_CLIENT_ID_URL,
      client_name: 'Solus',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      // A public client: the draft forbids a shared secret in the document.
      token_endpoint_auth_method: 'none',
    })
    expect(document).not.toHaveProperty('client_secret')
  })

  test('names only loopback callbacks over HTTP and HTTPS callbacks otherwise', () => {
    for (const uri of SOLUS_CLIENT_METADATA.redirect_uris) {
      const url = new URL(uri)
      // MCP 2026-07-28: every redirect URI is localhost or HTTPS.
      expect(url.protocol === 'https:' || ['127.0.0.1', 'localhost'].includes(url.hostname)).toBe(true)
    }
  })

  test('names the loopback callback a host on this build sends for a browser on the host', () => {
    // WHY: the host signs in with the document only for a callback it names; without this one, every desktop sign-in registers dynamically.
    expect(SOLUS_CLIENT_METADATA.redirect_uris).toContain(INTEGRATION_OAUTH_LOOPBACK_URL)
  })

  test('still names the host routes that hosts before the loopback callback build, on their default ports', () => {
    for (const port of [DEFAULT_DESKTOP_SERVER_PORT, DEFAULT_SERVER_PORT]) {
      for (const host of ['127.0.0.1', 'localhost']) {
        // WHY: an older host reads the same published document; dropping these would send its sign-ins to dynamic registration.
        expect(SOLUS_CLIENT_METADATA.redirect_uris).toContain(`http://${host}:${port}${INTEGRATION_OAUTH_CALLBACK_PATH}`)
      }
    }
  })
})

describe('a client ID URL', () => {
  test('follows the draft\'s rules', () => {
    expect(isClientIdUrl(SOLUS_CLIENT_ID_URL)).toBe(true)
    for (const bad of [
      'http://solus.sh/oauth/client-metadata.json',
      'https://solus.sh/',
      'https://solus.sh',
      'https://user@solus.sh/oauth/client-metadata.json',
      'https://solus.sh/oauth/client-metadata.json#top',
      'https://solus.sh/oauth/client-metadata.json?v=1',
      'https://solus.sh/oauth/../client-metadata.json',
      'https://solus.sh:443/oauth/client-metadata.json',
    ]) expect(isClientIdUrl(bad)).toBe(false)
  })

  test('a document is confirmed only for its own URL, and only as a public client', () => {
    expect(namesItsUrl(SOLUS_CLIENT_METADATA, 'https://solus.sh/other.json')).toBe(false)
    expect(clientMetadataDocumentSchema.safeParse({ ...SOLUS_CLIENT_METADATA, token_endpoint_auth_method: 'client_secret_post' }).success).toBe(false)
  })
})

describe('the host\'s read of the published document', () => {
  function reader(answers: Array<() => Response>) {
    let now = 0
    let reads = 0
    const fetchImpl: typeof fetch = Object.assign(async () => {
      const answer = answers[Math.min(reads, answers.length - 1)]
      reads++
      return answer()
    }, { preconnect: fetch.preconnect })
    const published = new PublishedClientMetadata({ fetch: fetchImpl, now: () => now })
    return { published, reads: () => reads, advance: (ms: number) => { now += ms } }
  }
  const ok = () => Response.json(SOLUS_CLIENT_METADATA)
  const missing = () => new Response('Not found', { status: 404 })
  const MINUTE = 60_000

  test('keeps a confirmed copy an hour, and for up to a day while reads fail', async () => {
    const { published, reads, advance } = reader([ok, missing])
    expect(await published.current()).toEqual(SOLUS_CLIENT_METADATA)
    advance(30 * MINUTE)
    expect(await published.current()).not.toBeNull()
    expect(reads()).toBe(1)
    advance(31 * MINUTE)
    // WHY: an outage of the site does not end sign-ins with a document every server already cached.
    expect(await published.current()).not.toBeNull()
    expect(reads()).toBe(2)
    advance(24 * 60 * MINUTE)
    // WHY: a document the site took down for a day is not relied on: the server would refuse the client.
    expect(await published.current()).toBeNull()
  })

  test('a failed read is not tried again for five minutes, then is', async () => {
    const { published, reads, advance } = reader([missing, missing, ok])
    expect(await published.current()).toBeNull()
    advance(4 * MINUTE)
    expect(await published.current()).toBeNull()
    // WHY: an offline host must not wait on the read at every sign-in.
    expect(reads()).toBe(1)
    advance(2 * MINUTE)
    expect(await published.current()).toBeNull()
    advance(6 * MINUTE)
    // Once the maintainer deploys the site, the next read confirms it.
    expect(await published.current()).toEqual(SOLUS_CLIENT_METADATA)
    expect(reads()).toBe(3)
  })

  test('a self-hosted deployment names its own document', async () => {
    const own = 'https://solus.example.com/oauth/client-metadata.json'
    process.env.SOLUS_OAUTH_CLIENT_METADATA_URL = own
    try {
      const { published } = reader([() => Response.json({ ...SOLUS_CLIENT_METADATA, client_id: own }), ok])
      expect((await published.current())?.client_id).toBe(own)
    } finally {
      delete process.env.SOLUS_OAUTH_CLIENT_METADATA_URL
    }
  })
})

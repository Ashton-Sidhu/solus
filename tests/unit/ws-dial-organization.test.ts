import { afterEach, describe, expect, mock, test } from 'bun:test'
import { createServer } from 'http'
import type { AddressInfo } from 'net'
import { Database } from 'bun:sqlite'
import type { HandshakeCredential } from '@solus/contracts/uplink'
import { WsTransport } from '@solus/client-core/ws-transport'
import { SolusApiClient, SolusApiHttp } from '@solus/contracts/solus-api/client'
import { SOLUS_API_ORGANIZATION_HEADER } from '@solus/contracts/solus-api/request'
import { connectionTokenResource } from '@solus/client-core/server-connection'
import { organizationIdFor } from '@solus/client-core/uplink-session'

// bun has no node:sqlite; the server modules' import chain reaches the db even though
// these tests never open it, so everything that reaches it loads after the seam.
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
const { SolusServer } = await import('@solus/server/transport/server')
const { ClientEventRegistry } = await import('@solus/server/transport/events/client-event-registry')
const { attachWebSocketTransport } = await import('@solus/server/transport/websocket')

// A Solus client's access token lists the organizations its person reaches a host
// through (ADR 0001 §6.4); the host admits the connection only in the one it names.
// So a dial with an account token names that organization in its handshake
// (handshake-credential.test.ts), and the record API names it on each HTTP request.
// A paired connection names none.

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

/** A host that records the one credential each handshake presents, and admits none. */
async function host() {
  const credentials: HandshakeCredential[] = []
  const http = createServer((_request, response) => { response.writeHead(404).end() })
  const transport = attachWebSocketTransport(http, new SolusServer(), {
    clientEvents: new ClientEventRegistry(),
    requireAuth: true,
    doors: {
      admitCredential: async (credential) => { credentials.push(credential); return { ok: false, reason: 'token-refused' } },
      admitBearer: async () => ({ ok: false, reason: 'not-accepted' }),
    },
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => transport.close())
  return { url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, credentials }
}

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !check(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5))
}

describe('the organization a dial names', () => {
  test('a paired connection presents its session token and names no organization', async () => {
    const server = await host()
    const transport = new WsTransport({ serverUrl: server.url, sessionToken: 'paired-token', dialOrganizationId: () => 'org_acme' })
    cleanups.push(() => transport.destroy())
    transport.start()
    await until(() => server.credentials.length > 0)
    expect(server.credentials[0]).toEqual({ kind: 'session-token', token: 'paired-token' })
  })

  test('the record API names the organization on each request, beside its own token', async () => {
    const sent: Array<{ authorization: string | null; organization: string | null }> = []
    const client = new SolusApiClient(new SolusApiHttp({
      baseUrl: () => 'https://api.example.test',
      contextKey: () => 'k',
      acquireSource: async () => 'access-token',
      organizationId: () => 'org_acme',
      fetchImpl: async (_input, init) => {
        const headers = new Headers(init?.headers)
        sent.push({ authorization: headers.get('authorization'), organization: headers.get(SOLUS_API_ORGANIZATION_HEADER) })
        return new Response(JSON.stringify({ error: { code: 'NOPE', message: 'no' } }), { status: 401 })
      },
    }))
    await client.request('capabilities').catch(() => null)
    expect(sent).toEqual([{ authorization: 'Bearer access-token', organization: 'org_acme' }])
  })

  test('a Solus API id asks for an API token; any other id for that host', () => {
    expect(connectionTokenResource('workspace:org_acme')).toEqual({ kind: 'api' })
    expect(connectionTokenResource('abcdefghijklmnop')).toEqual({ kind: 'host', hostId: 'abcdefghijklmnop' })
  })

  test('a host shared with several organizations is dialed in the window\'s one, else its first share', () => {
    const uplink = { hostId: 'h', directoryUrl: 'https://app.solus.sh', organizationIds: ['org_a', 'org_b'] }
    expect(organizationIdFor(null, uplink, 'org_b')).toBe('org_b')
    expect(organizationIdFor(null, uplink, 'org_other')).toBe('org_a')
  })
})

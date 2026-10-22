import { afterEach, describe, expect, test } from 'bun:test'
import { createServer, type IncomingMessage } from 'http'
import type { AddressInfo } from 'net'
import { WsTransport } from '@solus/client-core/ws-transport'
import { SolusApiClient, SolusApiHttp } from '@solus/contracts/solus-api/client'
import { connectionTokenResource } from '@solus/client-core/server-connection'
import { organizationIdFor } from '@solus/client-core/uplink-session'

// A Solus client's access token lists the organizations its person reaches a host
// through (ADR 0001 §6.4); the host admits the connection only in the one it names.
// So a dial with an account token names that organization in its handshake
// (handshake-credential.test.ts), and the record API names it at its credential
// exchange. A paired connection names none.

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => resolve(body))
  })
}

async function ticketDoor() {
  const requests: Array<{ authorization: string | undefined; contentType: string | undefined; body: string }> = []
  const server = createServer(async (request, response) => {
    if (request.url === '/auth/ws-ticket') requests.push({ authorization: request.headers.authorization, contentType: request.headers['content-type'], body: await readBody(request) })
    response.writeHead(401, { 'content-type': 'application/json' }).end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => server.close())
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests }
}

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !check(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5))
}

describe('the organization a dial names', () => {
  test('a paired connection presents its session token and names no organization', async () => {
    const door = await ticketDoor()
    const transport = new WsTransport({ serverUrl: door.url, sessionToken: 'paired-token', dialOrganizationId: () => 'org_acme' })
    cleanups.push(() => transport.destroy())
    transport.start()
    await until(() => door.requests.length > 0)
    expect(door.requests[0]).toEqual({ authorization: 'Bearer paired-token', contentType: undefined, body: '' })
  })

  test('the record API names the organization at its credential exchange', async () => {
    const bodies: string[] = []
    const client = new SolusApiClient(new SolusApiHttp({
      baseUrl: () => 'https://api.example.test',
      contextKey: () => 'k',
      acquireSource: async () => 'access-token',
      organizationId: () => 'org_acme',
      fetchImpl: async (_input, init) => {
        bodies.push(String(init?.body))
        return new Response(JSON.stringify({ error: { code: 'NOPE', message: 'no' } }), { status: 401 })
      },
    }))
    await client.request('capabilities').catch(() => null)
    expect(JSON.parse(bodies[0]!)).toMatchObject({ organizationId: 'org_acme' })
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

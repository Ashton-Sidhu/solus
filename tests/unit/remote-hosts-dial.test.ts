import { afterEach, describe, expect, mock, test } from 'bun:test'
import { createServer } from 'http'
import type { AddressInfo } from 'net'
import type { HandshakeCredential } from '@solus/contracts/uplink'
import type { IntroducedHost } from '@solus/contracts/host-api'
import { DatabaseSync } from './helpers/bun-sqlite'
import { identityKeyFor, signedHealth } from './helpers/signing-host'

// bun has no node:sqlite; the server modules' import chain reaches the db even though
// these tests never open it, so everything that reaches it loads after the seam.
mock.module('node:sqlite', () => ({ DatabaseSync }))
const { SolusServer } = await import('@solus/server/transport/server')
const { ClientEventRegistry } = await import('@solus/server/transport/events/client-event-registry')
const { attachWebSocketTransport } = await import('@solus/server/transport/websocket')
const { RemoteHosts } = await import('@solus/server/execution/orchestration/remote-hosts')

// WHY: host A reaches host B through the same `HostLink` a client holds
// (docs/plans/host-routes.md D1, D3). The person's credential goes to B only on a
// route that proves it is B: a device on B's old address that answers as another
// installation never gets it.

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

/** A host on loopback that answers `/health` as `answersAs`, and records each credential its handshakes present. */
async function host(answersAs: string) {
  const credentials: HandshakeCredential[] = []
  const http = createServer((request, response) => {
    if (!request.url?.startsWith('/health')) return void response.writeHead(404).end()
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(signedHealth(`http://127.0.0.1${request.url}`, answersAs)))
  })
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

/** This host, introduced to `introduced`: the owner reaches it with the session token it issued. */
function reachOf(introduced: IntroducedHost) {
  const hosts = new RemoteHosts(
    () => null,
    { list: () => ({ hosts: [introduced], refused: [] }), credential: async () => 'introduced-token' },
    () => 'this-host',
  )
  cleanups.push(() => hosts.close())
  return hosts
}

async function connectTo(hosts: InstanceType<typeof RemoteHosts>) {
  const target = await hosts.find({ account: null, isOwner: true }, 'Studio')
  if ('error' in target) throw new Error(target.error)
  const remote = hosts.connect(target)
  if ('error' in remote) throw new Error(remote.error)
  return remote
}

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !check(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5))
}

describe('a dial to another host', () => {
  test('goes to the route that proves it is the host, with the credential', async () => {
    const studio = await host('install-studio')
    await connectTo(reachOf({ installationId: 'install-studio', label: 'Studio', url: studio.url, identityKey: identityKeyFor('install-studio'), introducedAt: 1 }))
    await until(() => studio.credentials.length > 0)
    expect(studio.credentials).toEqual([{ kind: 'session-token', token: 'introduced-token' }])
  })

  test('sends no credential to a device that answers as another installation', async () => {
    const stranger = await host('install-someone-else')
    await connectTo(reachOf({ installationId: 'install-studio', label: 'Studio', url: stranger.url, identityKey: identityKeyFor('install-studio'), introducedAt: 1 }))
    // Long enough for a dial and its retry to reach the socket, had either sent a credential.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(stranger.credentials).toEqual([])
  })
})

import { afterEach, describe, expect, test } from 'bun:test'
import { clientFrameSchema } from '@solus/contracts/host-socket'
import type { DirectoryHost } from '@solus/contracts/uplink'
import { RemoteHosts } from '@solus/server/execution/orchestration/remote-hosts'
import { identityKeyFor, signedHealth } from './helpers/signing-host'

const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0)) close() })

function server(installationId: string, refuses = false) {
  const credentials: string[] = []
  let catalogs = 0
  const instance = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request, server) {
      if (new URL(request.url).pathname === '/health') return Response.json(signedHealth(request.url, installationId))
      if (server.upgrade(request)) return
      return new Response('Not found', { status: 404 })
    },
    websocket: {
      message(socket, text) {
        const frame = clientFrameSchema.parse(JSON.parse(String(text)))
        if (frame.t === 'rpc') { catalogs++; return }
        if (frame.t !== 'hello') return
        if (frame.credential?.kind === 'access-token') credentials.push(frame.credential.token)
        if (refuses) {
          socket.send(JSON.stringify({ t: 'refused', code: 'UNAUTHORIZED', message: 'Sign in again' }))
          socket.close(1008, 'Unauthorized')
        } else socket.send(JSON.stringify({ t: 'welcome', epoch: 'test', seq: 0, recovered: false }))
      },
    },
  })
  cleanup.push(() => { instance.stop(true) })
  return { url: `http://127.0.0.1:${instance.port}`, credentials, catalogs: () => catalogs }
}
function machine(hostId: string, url?: string, managedState?: DirectoryHost['managedState']): DirectoryHost {
  return { hostId, installationId: hostId, label: hostId, routes: url ? [{ kind: 'lan', url }] : [],
    kind: managedState ? 'cloud' : 'personal', organizationIds: [], ...(managedState ? { hasManagedCompute: true, managedState } : {}) }
}
function hosts(directory: DirectoryHost[], keys: Map<string, string>, token: string | null = 'private-host-grant') {
  const owner = new RemoteHosts(() => ({ hosts: async () => directory, accessToken: async () => token }),
    // Account routes use the saved identity keys without exposing the introduction to members.
    { list: () => ({ hosts: [...keys].map(([installationId, identityKey]) => ({ installationId, identityKey, label: installationId, url: 'https://unused.example', introducedAt: 0 })), refused: [] }), credential: async () => null },
    () => 'self')
  cleanup.push(() => owner.close())
  return owner
}
const ACCOUNT_MEMBER = { account: { userId: 'alice', scope: 'personal' as const }, isOwner: false }

describe('machine status without a model catalog', () => {
  test('reports online, refused, unreachable, and stopped hosts without exposing credentials', async () => {
    const up = server('online')
    const refused = server('refused', true)
    const owner = hosts([machine('online', up.url), machine('refused', refused.url), machine('no-route'), machine('stopped', up.url, 'stopped')],
      new Map([['online', identityKeyFor('online')], ['refused', identityKeyFor('refused')]]))
    const result = await owner.summaries(ACCOUNT_MEMBER)
    expect(result.map((host) => [host.id, host.status])).toEqual([
      ['online', 'online'], ['refused', 'auth-required'], ['no-route', 'unreachable'], ['stopped', 'not-ready'],
    ])
    expect(result.at(-1)?.managedState).toBe('stopped')
    expect(JSON.stringify(result)).not.toContain('private-host-grant')
    expect(up.credentials).toEqual(['private-host-grant'])
    expect(up.catalogs() + refused.catalogs()).toBe(0)
    const missing = await owner.find(ACCOUNT_MEMBER, 'no-route')
    if ('error' in missing) throw new Error(missing.error)
    expect(owner.connect(missing)).toHaveProperty('error')
  })

  test('does not send a credential when a reused route answers as another machine', async () => {
    const impostor = server('impostor')
    const owner = hosts([machine('expected', impostor.url)], new Map([['expected', identityKeyFor('expected')]]))
    expect((await owner.summaries(ACCOUNT_MEMBER))[0]?.status).toBe('unreachable')
    expect(impostor.credentials).toEqual([])
  })

  test('a missing grant is a sign-in problem, not an online claim', async () => {
    const up = server('online')
    const owner = hosts([machine('online', up.url)], new Map([['online', identityKeyFor('online')]]), null)
    expect((await owner.summaries(ACCOUNT_MEMBER))[0]?.status).toBe('auth-required')
    expect(up.credentials).toEqual([])
  })
})

import { describe, expect, test } from 'bun:test'
import { webUplinkAccountSource } from '@solus/client-core/uplink-session'
import {
  createManagedHost,
  deleteManagedHost,
  restartManagedHost,
  stopManagedHost,
  updateManagedHostSpec,
  type CloudRequester,
} from '@solus/desktop-main/account/uplink-client'

// Every client manages a Solus Cloud machine through the
// account's `/v1` routes. Delete is the machine route, never `DELETE /v1/hosts/<id>`,
// which only ends a registration and leaves the machine running.

const ORIGIN = 'https://app.solus.test'

interface Call { url: string; method: string | undefined; body: unknown }

function webSource(answer: (call: Call) => Response) {
  const calls: Call[] = []
  const source = webUplinkAccountSource(ORIGIN, { accessToken: async () => 'account-token' }, (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), method: init?.method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined }
    calls.push(call)
    return answer(call)
  }) as typeof fetch)
  return { source, calls }
}

describe('the web client manages a cloud machine', () => {
  test('stop and restart post to their routes and answer the lifecycle', async () => {
    const { source, calls } = webSource(() => Response.json({ lifecycle: 'stopping' }))
    expect(await source.stopManagedHost('host_1')).toBe('stopping')
    expect(await source.restartManagedHost('host_1')).toBe('stopping')
    expect(calls).toEqual([
      { url: `${ORIGIN}/v1/hosts/host_1/stop`, method: 'POST', body: undefined },
      { url: `${ORIGIN}/v1/hosts/host_1/restart`, method: 'POST', body: undefined },
    ])
  })

  test('a refused stop or restart reads as no answer, never as a new state', async () => {
    const { source } = webSource(() => Response.json({ error: 'host_not_found' }, { status: 404 }))
    expect(await source.stopManagedHost('host_1')).toBeNull()
    expect(await source.restartManagedHost('host_1')).toBeNull()
  })

  test('a spec change patches the spec route and answers whether anything changed', async () => {
    const { source, calls } = webSource(() => Response.json({ changed: true }))
    expect(await source.updateManagedHostSpec('host_1', { packages: ['ripgrep'] })).toBe(true)
    expect(calls).toEqual([{ url: `${ORIGIN}/v1/hosts/host_1/spec`, method: 'PATCH', body: { packages: ['ripgrep'] } }])

    const refused = webSource(() => Response.json({ error: 'forbidden' }, { status: 403 }))
    expect(await refused.source.updateManagedHostSpec('host_1', { setupScript: '' })).toBeNull()
  })

  test('delete removes the machine, not only the registration, and a gone machine is deleted', async () => {
    const { source, calls } = webSource(() => new Response(null, { status: 204 }))
    expect(await source.deleteManagedHost('host_1')).toBe(true)
    expect(calls).toEqual([{ url: `${ORIGIN}/v1/hosts/host_1/machine`, method: 'DELETE', body: undefined }])

    expect(await webSource(() => Response.json({ error: 'host_not_found' }, { status: 404 })).source.deleteManagedHost('host_1')).toBe(true)
    expect(await webSource(() => Response.json({ error: 'forbidden' }, { status: 403 })).source.deleteManagedHost('host_1')).toBe(false)
  })

  test('create sends the organization, name, and spec, and names a refusal by its code', async () => {
    const { source, calls } = webSource(() => Response.json({ hostId: 'host_new' }, { status: 201 }))
    expect(await source.createManagedHost('org_1', { label: 'Build box', spec: { size: 'large' } })).toEqual({ ok: true, hostId: 'host_new' })
    expect(calls).toEqual([{ url: `${ORIGIN}/v1/hosts`, method: 'POST', body: { organizationId: 'org_1', label: 'Build box', spec: { size: 'large' } } }])

    const refused = webSource(() => Response.json({ error: 'managed_host_limit', message: 'one per organization' }, { status: 409 }))
    expect(await refused.source.createManagedHost('org_1', { label: 'Build box' })).toEqual({ ok: false, code: 'managed_host_limit', message: 'one per organization' })
  })

  test('the account read gives the size catalog to every client', async () => {
    const catalog = { sizes: [{ id: 'small', label: 'Small', detail: '2 CPU' }], defaultSize: 'small', supportsPackages: true, supportsSetupScript: true }
    const { source, calls } = webSource(() => Response.json({ userId: 'u1', onboardingCompletedAt: null, activeOrganizationId: null, organizations: [], managedHostCatalog: catalog }))
    expect((await source.readAccount())?.managedHostCatalog).toEqual(catalog)
    expect(calls.map((call) => call.url)).toEqual([`${ORIGIN}/v1/account`])
  })
})

function desktopRequester(answer: () => Response | null) {
  const calls: Array<{ path: string; method: string | undefined; body: unknown; contentType: string | null }> = []
  const client: CloudRequester = {
    cloudOrigin: ORIGIN,
    async cloudRequest(path, init = {}) {
      calls.push({
        path,
        method: init.method,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
        contentType: new Headers(init.headers).get('content-type'),
      })
      return answer()
    },
  }
  return { client, calls }
}

describe('desktop main manages a cloud machine for the renderer', () => {
  test('each call goes to the same route the web client uses', async () => {
    const lifecycle = desktopRequester(() => Response.json({ lifecycle: 'starting' }))
    expect(await stopManagedHost(lifecycle.client, 'host_1')).toBe('starting')
    expect(await restartManagedHost(lifecycle.client, 'host_1')).toBe('starting')
    expect(lifecycle.calls.map(({ path, method }) => ({ path, method }))).toEqual([
      { path: '/v1/hosts/host_1/stop', method: 'POST' },
      { path: '/v1/hosts/host_1/restart', method: 'POST' },
    ])

    const spec = desktopRequester(() => Response.json({ changed: false }))
    expect(await updateManagedHostSpec(spec.client, 'host_1', { packages: [] })).toBe(false)
    expect(spec.calls).toEqual([{ path: '/v1/hosts/host_1/spec', method: 'PATCH', body: { packages: [] }, contentType: 'application/json' }])

    const removal = desktopRequester(() => new Response(null, { status: 204 }))
    expect(await deleteManagedHost(removal.client, 'host_1')).toBe(true)
    expect(removal.calls.map(({ path, method }) => ({ path, method }))).toEqual([{ path: '/v1/hosts/host_1/machine', method: 'DELETE' }])
  })

  test('signed out, nothing is stopped, deleted, or created', async () => {
    const { client } = desktopRequester(() => null)
    expect(await stopManagedHost(client, 'host_1')).toBeNull()
    expect(await deleteManagedHost(client, 'host_1')).toBe(false)
    expect(await createManagedHost(client, 'org_1', { label: 'Box' })).toEqual({ ok: false, code: null, message: null })
  })
})

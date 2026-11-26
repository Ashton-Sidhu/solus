import { afterEach, expect, mock, test } from 'bun:test'
import { routesForMachine, type HostRoute } from '@solus/contracts/host-routes'
import { catalogHostTarget, preferredRouteUrl } from '@solus/client-core/server-connection'
import type { KnownHost } from '@solus/client-core/known-host'
import { adoptRegistration, resetMachineKindForTests } from '@solus/server/host/machine-kind'
import { DatabaseSync } from './helpers/bun-sqlite'

// Bun has no node:sqlite; the endpoints reach the database through the host's paired devices.
mock.module('node:sqlite', () => ({ DatabaseSync }))
const { advertisedRoutes } = await import('@solus/server/transport/endpoints')

const internal: HostRoute = { kind: 'lan', url: 'http://10.0.0.1:3000', source: 'host' }
const tunnel: HostRoute = { kind: 'tunnel', url: 'https://managed.example.test', source: 'directory' }

afterEach(resetMachineKindForTests)

test('managed servers do not advertise their private cloud interfaces', async () => {
  adoptRegistration({ organizationId: 'org-test' })
  expect(await advertisedRoutes('0.0.0.0', 3000)).toEqual([])
})

test('managed routes exclude all private paths; personal machines keep their routes', () => {
  const routes: HostRoute[] = [internal, { kind: 'tailnet', url: 'http://100.64.0.1:3000' }, { kind: 'forwarded', url: 'http://127.0.0.1:4000', viaHostId: 'local' }, tunnel]
  expect(routesForMachine(routes, 'cloud')).toEqual([tunnel])
  expect(routesForMachine(routes, 'personal')).toEqual(routes)
  expect(routesForMachine(routes)).toEqual(routes)
  expect(routesForMachine([internal], 'cloud')).toEqual([])
})

test('desktop and web restore a managed host on its tunnel despite a known internal route', () => {
  const saved: KnownHost = {
    id: 'managed:test', installationId: 'managed:test', label: 'Cloud host',
    sessionToken: '', lastConnected: 0, routes: [internal, tunnel],
    uplink: { hostId: 'test', directoryUrl: 'https://account.example.test', kind: 'cloud' },
  }
  expect(preferredRouteUrl(saved, 'http://localhost:3001')).toBe(tunnel.url)
  const target = catalogHostTarget({ find: () => saved }, saved)
  expect(target.url).toBe(tunnel.url)
  expect(target.routes).toEqual([tunnel])
  expect(preferredRouteUrl({ ...saved, routes: [internal] }, 'http://localhost:3001')).toBe('')
})

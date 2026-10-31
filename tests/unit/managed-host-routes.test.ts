import { afterEach, expect, test } from 'bun:test'
import { routesForMachine, type HostRoute } from '@solus/contracts/host-routes'
import { preferredRouteUrl, savedServerTarget } from '@solus/client-core/server-connection'
import type { SavedServer } from '@solus/client-core/server-registry'
import { advertisedRoutes } from '@solus/server/transport/endpoints'
import { adoptProvisionedRegistration, resetHostCategoryForTests } from '@solus/server/host/host-category'

const internal: HostRoute = { kind: 'lan', url: 'http://10.0.0.1:3000', source: 'host' }
const tunnel: HostRoute = { kind: 'tunnel', url: 'https://managed.example.test', source: 'directory' }

afterEach(resetHostCategoryForTests)

test('managed servers do not advertise their private cloud interfaces', async () => {
  adoptProvisionedRegistration({ organizationId: 'org-test' })
  expect(await advertisedRoutes('0.0.0.0', 3000)).toEqual([])
})

test('managed routes exclude all private paths; personal machines keep their routes', () => {
  const routes: HostRoute[] = [internal, { kind: 'tailnet', url: 'http://100.64.0.1:3000' }, { kind: 'forwarded', url: 'http://127.0.0.1:4000', viaHostId: 'local' }, tunnel]
  expect(routesForMachine(routes, 'managed')).toEqual([tunnel])
  expect(routesForMachine(routes, 'personal')).toEqual(routes)
  expect(routesForMachine(routes)).toEqual(routes)
  expect(routesForMachine([internal], 'managed')).toEqual([])
})

test('desktop and web restore a managed host on its tunnel despite a saved internal route', () => {
  const saved: SavedServer = {
    id: 'managed:test', installationId: 'managed:test', label: 'Cloud host',
    sessionToken: '', lastConnected: 0, routes: [internal, tunnel],
    uplink: { hostId: 'test', directoryUrl: 'https://account.example.test', kind: 'managed' },
  }
  expect(preferredRouteUrl(saved, 'http://localhost:3001')).toBe(tunnel.url)
  expect(savedServerTarget(saved)).toMatchObject({ url: tunnel.url, routes: [tunnel] })
  expect(preferredRouteUrl({ ...saved, routes: [internal] }, 'http://localhost:3001')).toBe('')
})

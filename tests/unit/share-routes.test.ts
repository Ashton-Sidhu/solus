import { describe, expect, test } from 'bun:test'
import { shareRoutesFor } from '@solus/server/sharing/share-routes'
import type { ReachableEndpoint } from '@solus/server/transport/endpoints'

// docs/plans/host-sharing.md §4.1 step 2: a link names the host. The tunnel is the
// route when it is up; otherwise the tailnet address a visitor off this machine can dial.
describe('share routes', () => {
  const endpoints: ReachableEndpoint[] = [
    { kind: 'loopback', label: 'Localhost', host: '127.0.0.1', port: 7777 },
    { kind: 'lan', label: 'en0 (192.168.1.42)', host: '192.168.1.42', port: 7777 },
    { kind: 'tailnet', label: 'Tailnet (100.64.0.9)', host: '100.64.0.9', port: 7777 },
  ]

  test('the tunnel alone when it is online', () => {
    // WHY: a tunnel link opens from anywhere; a LAN address beside it would only be a dead link off the network.
    expect(shareRoutesFor('https://h-abc.tunnel.example', endpoints)).toEqual([{ kind: 'tunnel', url: 'https://h-abc.tunnel.example' }])
  })

  test('the tailnet, never a LAN address or loopback, when there is no tunnel', () => {
    // WHY (custom-roles.md §9): the link's secret is the whole credential. The tailnet
    // encrypts it; a LAN address is plain HTTP that anyone on the Wi-Fi can read, and
    // loopback is this machine only.
    expect(shareRoutesFor(null, endpoints)).toEqual([{ kind: 'direct', url: 'http://100.64.0.9:7777' }])
  })

  test('nothing when the host has only loopback and LAN addresses and no tunnel', () => {
    // WHY: the dialog must say there is no link rather than hand out one that leaks its secret or that nobody can open.
    expect(shareRoutesFor(null, [endpoints[0]!, endpoints[1]!])).toEqual([])
  })
})

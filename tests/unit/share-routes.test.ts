import { describe, expect, test } from 'bun:test'
import { shareRoutesFor } from '@solus/server/sharing/share-routes'
import type { ReachableEndpoint } from '@solus/server/transport/endpoints'

// docs/plans/host-sharing.md §4.1 step 2: a link names the host. The tunnel is the
// route when it is up; otherwise the addresses a visitor off this machine can dial.
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

  test('tailnet before LAN, and never loopback, when there is no tunnel', () => {
    // WHY: loopback is this machine only, so it is no link; the tailnet reaches further than one Wi-Fi.
    expect(shareRoutesFor(null, endpoints)).toEqual([
      { kind: 'tailnet', url: 'http://100.64.0.9:7777' },
      { kind: 'lan', url: 'http://192.168.1.42:7777' },
    ])
  })

  test('nothing when the host is loopback-only and has no tunnel', () => {
    // WHY: the dialog must say there is no link rather than hand out one nobody can open.
    expect(shareRoutesFor(null, [endpoints[0]!])).toEqual([])
  })
})

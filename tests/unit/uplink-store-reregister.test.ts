import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { UplinkStatus } from '@solus/contracts/uplink'

// ADR 0001 §2.2 rule 8: a signed-in owner's client registers a host it manages that is
// not registered. When Solus cloud refuses a host's registration, the host forgets it and
// broadcasts `host.uplinkStatusChanged`; the client registers it again then, not only
// when a settings view next opens. Without this, a host stayed unable to read the account
// although its owner was signed in and connected.

let statusListener: ((serverId: string, status: UplinkStatus) => void) | null = null
const registered: string[] = []

mock.module('@solus/client-core/host-events', () => ({
  subscribeAllHosts: (_topic: string, listener: (serverId: string, status: UplinkStatus) => void) => {
    statusListener = listener
    return () => { statusListener = null }
  },
}))
mock.module('@solus/client-core/server-connections', () => ({
  serverConnections: {
    serverInfoFor: async () => ({}),
    apiFor: (serverId: string) => ({
      uplinkStatus: async () => statusOf(false),
      uplinkRegister: async () => {
        registered.push(serverId)
        return statusOf(true)
      },
    }),
  },
}))
mock.module('@solus/client-core/uplink-control', () => ({ uplinkControl: () => 'manage' }))
mock.module('@solus/client-core/uplink-account', () => ({
  uplinkAccountSource: () => ({ issueEnrollmentTicket: async () => ({ ticket: 'ticket', directoryUrl: 'https://cloud.invalid' }) }),
}))
mock.module('@solus/workspace-ui/lib/toasts', () => ({ toasts: { error() {}, success() {}, info() {} } }))
mock.module('@solus/workspace-ui/contexts/account/account.store.svelte', () => ({ accountStore: { isSignedIn: true } }))
mock.module('@solus/workspace-ui/contexts/connections/servers.store.svelte', () => ({
  serversStore: { directorySignedIn: true, refreshDirectory: async () => {} },
}))

function statusOf(isRegistered: boolean): UplinkStatus {
  const status = { registration: { registered: isRegistered }, link: { linked: false } }
  return status as unknown as UplinkStatus
}

// The store's one rune, outside the Svelte compiler.
;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
const { uplinkStore } = await import('@solus/workspace-ui/contexts/connections/uplink.store.svelte')

describe('a host that is no longer registered', () => {
  beforeEach(() => {
    registered.length = 0
    uplinkStore.listen()
  })

  test('is registered again by the signed-in owner client as soon as it says so', async () => {
    statusListener?.('omarchy', statusOf(false))
    await Bun.sleep(0)
    expect(registered).toEqual(['omarchy'])
    expect(uplinkStore.statusFor('omarchy')?.registration.registered).toBe(true)
  })

  test('a registered host is left alone', async () => {
    statusListener?.('omarchy', statusOf(true))
    await Bun.sleep(0)
    expect(registered).toEqual([])
  })
})

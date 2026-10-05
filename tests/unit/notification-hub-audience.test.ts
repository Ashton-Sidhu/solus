import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { Principal } from '@solus/server/admission/principal'
import { RPC_PLANES } from '@solus/contracts/rpc-planes'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

let notificationRecipientClients: typeof import('@solus/server/notifications/hub-events').notificationRecipientClients
let rpcAccessClass: typeof import('@solus/server/admission/access-policy').rpcAccessClass

beforeAll(async () => {
  ;({ notificationRecipientClients } = await import('@solus/server/notifications/hub-events'))
  ;({ rpcAccessClass } = await import('@solus/server/admission/access-policy'))
})

// plans/015-notifications-hub.md §3, stage 2: `notifications.changed` reaches only
// the recipient's own connections in the organization the row belongs to; a guest,
// a runner, and other members never hear it. The hub's methods are personal reads
// in the collaboration plane that a guest connection cannot call.

const member = (userId: string, organizationId: string): Principal => ({
  kind: 'org-member', userId, organizationId, organizationRole: 'member', teamIds: [], hostKind: 'personal',
  displayName: userId, deviceId: `${userId}-${organizationId}`, deviceLabel: 'Browser', expiresAt: Date.now() + 60_000,
})

describe('notification event audience', () => {
  const principals = new Map<string, Principal>([
    ['bob-org1', member('bob', 'org1')],
    ['bob-org1-phone', member('bob', 'org1')],
    ['bob-org2', member('bob', 'org2')],
    ['carol-org1', member('carol', 'org1')],
    ['guest', { kind: 'guest', guestId: 'bob', organizationId: 'org1', displayName: 'Bob', deviceId: 'bob', expiresAt: 0, deviceLabel: 'Guest link', share: { resource: { kind: 'work', id: 'w' }, role: 'viewer', sharedByUserId: 'a', linkSecretHash: 'x' } }],
    ['runner', { kind: 'runner', hostId: 'h', organizationId: 'org1', ownerUserId: 'bob', deviceId: 'h', expiresAt: 0, deviceLabel: 'Runner' }],
  ])

  test('only the recipient\'s connections admitted to the row\'s organization hear a change', () => {
    const heard = notificationRecipientClients([...principals.keys()], (clientId) => principals.get(clientId), { organizationId: 'org1', recipientKey: 'bob' })
    expect(heard).toEqual(['bob-org1', 'bob-org1-phone'])
  })

  test('a client with no principal hears nothing', () => {
    expect(notificationRecipientClients(['unknown'], () => null, { organizationId: 'org1', recipientKey: 'bob' })).toEqual([])
  })

  test('the hub methods are collaboration-plane personal reads, refused to guests', () => {
    for (const method of ['notificationsCapability', 'notificationsList', 'notificationsCount', 'notificationsSetRead', 'notificationsSetArchived'] as const) {
      expect(RPC_PLANES[method]).toBe('collaboration')
      expect(rpcAccessClass(method)).toBe('host-wide')
    }
  })
})

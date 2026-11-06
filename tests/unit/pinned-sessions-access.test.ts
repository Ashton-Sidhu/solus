import { expect, mock, test } from 'bun:test'
import type { Principal } from '@solus/server/admission/principal'
import { DatabaseSync } from './helpers/bun-sqlite'
import { installTestIdentities } from './helpers/acting-identities'

mock.module('node:sqlite', () => ({ DatabaseSync }))
const { SolusServer } = await import('@solus/server/transport/server')
const { registerPinnedSessionsHandlers } = await import('@solus/server/transport/handlers/pinned-sessions-handlers')
installTestIdentities()

// plans/031 item 8: the pins are the host owner's own. A guest or a member listed
// them and saw the titles and folders of the owner's pinned sessions.

const GUEST: Principal = {
  kind: 'guest', guestId: 'g1', displayName: 'Maya', deviceId: 'g1', expiresAt: 0, deviceLabel: 'Guest link', organizationId: 'org1',
  share: { resource: { kind: 'session', id: 'shared' }, role: 'viewer', sharedByUserId: 'local:L1', linkSecretHash: 'h' },
}

test('a guest gets no pins and cannot pin', async () => {
  const server = new SolusServer()
  registerPinnedSessionsHandlers(server)
  expect(await server.handle('pinnedSessionsList', [] as never, { clientId: 'g', principal: GUEST })).toEqual([])
  await expect(server.handle('togglePinnedSession', [{ sessionId: 'shared' }] as never, { clientId: 'g', principal: GUEST })).rejects.toThrow()
})

import { afterEach, expect, test } from 'bun:test'
import type { Principal } from '@solus/server/admission/principal'
import { installToolAccess, toolMayRead, withWorkspaceToolAuthority } from '@solus/server/admission/workspace-tool-authority'

// plans/031 item 7: an agent tool read any session or plan on the host, so a member's
// or a guest's agent turn on the owner's machine could read the owner's private
// sessions. A tool now reads only what the turn's person may open.

const GUEST: Principal = {
  kind: 'guest', guestId: 'g1', displayName: 'Maya', deviceId: 'g1', expiresAt: 0, deviceLabel: 'Guest link', organizationId: 'org1',
  share: { resource: { kind: 'session', id: 'shared' }, role: 'viewer', sharedByUserId: 'local:L1', linkSecretHash: 'h' },
}
const OWNER: Principal = { kind: 'owner', via: 'local', expiresAt: null, deviceId: null, deviceLabel: 'Mac' }

afterEach(() => installToolAccess(async () => 'owner'))

test('a guest turn reads only its shared session; the owner and the host itself read everything', async () => {
  installToolAccess(async (principal, resource) => principal.kind === 'guest' && resource.id !== 'shared' ? 'none' : 'owner')
  expect(await withWorkspaceToolAuthority(GUEST, () => toolMayRead({ kind: 'session', id: 'private' }))).toBe(false)
  expect(await withWorkspaceToolAuthority(GUEST, () => toolMayRead({ kind: 'session', id: 'shared' }))).toBe(true)
  expect(await withWorkspaceToolAuthority(OWNER, () => toolMayRead({ kind: 'session', id: 'private' }))).toBe(true)
  // The host's own work runs with no turn person.
  expect(await toolMayRead({ kind: 'session', id: 'private' })).toBe(true)
})

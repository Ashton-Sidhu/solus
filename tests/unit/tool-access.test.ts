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

// The same rule for commands: an agent's send, stop, queue change, release,
// start, or fork is the RPC a person's client sends, for the same session, so a
// guest's or a member's turn acts only where that person may act.
test('a command from a guest turn obeys the RPC rules; the owner and the host itself may send it', async () => {
  const { assertToolMay } = await import('@solus/server/admission/workspace-tool-authority')
  const standings = {
    // The owner owns every session on the host; the guest's link reaches only the shared one.
    standingFor: async (principal: Principal, resource: { id: string }) => ({ role: principal.kind === 'owner' ? 'owner' as const : resource.id === 'shared' ? 'editor' as const : 'none' as const }),
  }
  installToolAccess(async () => 'owner', standings)
  const asGuest = (command: Parameters<typeof assertToolMay>[0], sessionId?: string) => withWorkspaceToolAuthority(GUEST, () => assertToolMay(command, sessionId))
  for (const command of ['promptHeadlessSession', 'stopSession', 'sessionQueueChange', 'rateLimitDecision', 'forkSessionFromResponse', 'setSessionTitle'] as const) {
    await expect(asGuest(command, 'private')).rejects.toThrow()
    await expect(withWorkspaceToolAuthority(OWNER, () => assertToolMay(command, 'private'))).resolves.toBeUndefined()
    // The host's own work runs with no turn person.
    await expect(assertToolMay(command, 'private')).resolves.toBeUndefined()
  }
  // On the session its link gives it as an editor, the guest's turn may prompt.
  await expect(asGuest('promptHeadlessSession', 'shared')).resolves.toBeUndefined()
  // A guest starts no session on the host.
  await expect(asGuest('createHeadlessSession')).rejects.toThrow()
})

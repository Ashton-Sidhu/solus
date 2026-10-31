import { expect, mock, test } from 'bun:test'
import { awaitingSignIn } from '@solus/client-core/uplink-account'
import type { UplinkAccountSource } from '@solus/client-core/uplink-session'

// docs/plans/instant-share-open.md §4.14: a host dialed from the shell's directory
// opens its socket before the page's sign-in completes. Its handshake asks for a
// token at once; the token must wait for the sign-in, not fail because no grant is
// held yet, or the early socket is refused and dialed again.

function source(token: string | null): UplinkAccountSource & { accessToken: ReturnType<typeof mock> } {
  return {
    listDirectory: async () => null,
    accessToken: mock(async () => token),
    isSignedOut: () => false,
    issueEnrollmentTicket: async () => null,
    loadOrganizationDirectory: async () => null,
    startManagedHost: async () => null,
    removeHost: async () => false,
  }
}

const resource = { kind: 'host', hostId: 'host-1' } as const

test('a token asked for before the sign-in completes waits for it, then comes from the account', async () => {
  const account = source('host-token')
  const signIn = Promise.withResolvers<boolean>()
  const token = awaitingSignIn(account, signIn.promise).accessToken(resource)
  await Promise.resolve()
  expect(account.accessToken).not.toHaveBeenCalled()
  signIn.resolve(true)
  expect(await token).toBe('host-token')
  expect(account.accessToken).toHaveBeenCalledWith(resource, undefined)
})

test('a page that does not sign in gets no token, and the account is not asked', async () => {
  const account = source('host-token')
  expect(await awaitingSignIn(account, Promise.resolve(false)).accessToken(resource)).toBeNull()
  expect(account.accessToken).not.toHaveBeenCalled()
})

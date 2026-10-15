import { describe, expect, test } from 'bun:test'
import { cloudConnectionsPointerUrl } from '../../packages/workspace-ui/src/components/seats/lib/cloud-connections'
import type { HostIdentity } from '../../packages/workspace-ui/src/contexts/sharing/shares.store.svelte'

// docs/plans/cloud-vault.md §2.5, "Signed in means the account": a signed-in
// person's GitHub, Google, and Atlassian connections are in their Solus account,
// and the host names that page (`accountConnectionsUrl`) for the owner of a linked
// host and for every member. Only the owner of a host that is not linked keeps the
// host's own connections. The workspace service itself is never a settings host
// (cloud-service-model.md §15), so there is no cloud row to ask.

const directoryUrl = 'https://app.solus.sh/'
const member: HostIdentity = { principal: 'org-member', userId: 'u1', organizationId: 'org 1' }

describe('where a host row keeps a person’s connections', () => {
  test('an account-authenticated runner points directly to the account page', () => {
    expect(cloudConnectionsPointerUrl({ identity: member, directoryUrl })).toBe('https://app.solus.sh/connections')
  })

  test('a cloud-managed host answer points to the account page even when absent from the directory', () => {
    const identity: HostIdentity = { principal: 'remote-owner', userId: 'alice', organizationId: null, accountConnectionsUrl: 'https://account.example/connections' }
    expect(cloudConnectionsPointerUrl({ identity, directoryUrl: undefined })).toBe(identity.accountConnectionsUrl!)
  })

  test('a signed-out local client and an anonymous guest do not get account integration controls', () => {
    for (const principal of ['local-owner', 'guest'] as const) {
      const identity: HostIdentity = { principal, userId: null, organizationId: null }
      expect(cloudConnectionsPointerUrl({ identity, directoryUrl })).toBeNull()
    }
    expect(cloudConnectionsPointerUrl({ identity: undefined, directoryUrl })).toBeNull()
  })

  test('with no account page from the host, an owner keeps the host sections', () => {
    const identity: HostIdentity = { principal: 'remote-owner', userId: 'alice', organizationId: null }
    expect(cloudConnectionsPointerUrl({ identity, directoryUrl })).toBeNull()
    expect(cloudConnectionsPointerUrl({ identity: member, directoryUrl: undefined })).toBeNull()
  })
})

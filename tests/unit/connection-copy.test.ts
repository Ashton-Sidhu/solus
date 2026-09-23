import { describe, expect, test } from 'bun:test'
import { cloudConnectionsPointerUrl } from '../../packages/workspace-ui/src/components/seats/lib/cloud-connections'
import type { HostIdentity } from '../../packages/workspace-ui/src/contexts/sharing/shares.store.svelte'

// docs/plans/cloud-service-model.md §26: the owner of a personal host connects GitHub,
// Google, and Atlassian on that host, signed in or not. Account connections in Solus
// cloud are for cloud-managed hosts and for members, so a member never overwrites
// the host's own connections. The workspace service itself is never a settings host
// (§15), so there is no cloud row to ask.

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

  test('the owner of a linked personal host keeps the host sections', () => {
    const identity: HostIdentity = { principal: 'remote-owner', userId: 'alice', organizationId: null }
    expect(cloudConnectionsPointerUrl({ identity, directoryUrl })).toBeNull()
    expect(cloudConnectionsPointerUrl({ identity: member, directoryUrl: undefined })).toBeNull()
  })
})

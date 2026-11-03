import { describe, expect, test } from 'bun:test'
import type { PolicyDocument, PolicySet } from '../../packages/contracts/src/policy'
import { HostPolicies } from '../../packages/contracts/src/host-policies'
import { updatePolicyOf } from '../../apps/desktop/src/main/updates/update-policy'
import { reduceUpdateState } from '../../apps/desktop/src/main/updates/update-status'

// An administrator who turns updates off must stop the desktop app from
// checking, downloading, or installing, and a custom feed must replace the
// Solus releases (plans/030 §6.8). Host keys come from the MDM policy first,
// then from the host-owning organization's host policy (§3).

function document(name: string, updates: NonNullable<PolicyDocument['host']>['updates']): PolicyDocument {
  return { schemaVersion: 1, organization: { name }, host: { updates } }
}

function mdmSet(updates: NonNullable<PolicyDocument['host']>['updates']): PolicySet {
  return { ...HostPolicies.none.set, mdm: { kind: 'mdm', organizationId: null, document: document('Example Corp', updates) } }
}

describe('desktop update policy', () => {
  test('no policy leaves updates to the person and the package.json feed', () => {
    expect(updatePolicyOf(HostPolicies.none)).toEqual({ managedMessage: null, feedUrl: null })
  })

  test('mode off names the organization that manages updates', () => {
    expect(updatePolicyOf(new HostPolicies(mdmSet({ mode: 'off' }))).managedMessage).toBe('Example Corp manages Solus updates.')
  })

  test('a feed URL reaches the updater while updates stay automatic', () => {
    expect(updatePolicyOf(new HostPolicies(mdmSet({ mode: 'auto', feedUrl: 'https://updates.example.com/solus/' }))))
      .toEqual({ managedMessage: null, feedUrl: 'https://updates.example.com/solus/' })
  })

  test('the host-owning organization manages updates when there is no MDM policy', () => {
    const set: PolicySet = {
      mdm: null,
      hostOwnerOrganizationId: 'org_acme',
      organizations: {
        org_acme: {
          state: 'ready',
          policy: { kind: 'organization', organizationId: 'org_acme', document: { schemaVersion: 1, organization: { name: 'Acme' } } },
          hostPolicy: { kind: 'host', organizationId: 'org_acme', document: document('Acme', { mode: 'off' }) },
        },
      },
    }
    expect(updatePolicyOf(new HostPolicies(set)).managedMessage).toBe('Acme manages Solus updates.')
  })

  test('the MDM policy wins over the host-owning organization', () => {
    const set: PolicySet = {
      ...mdmSet({ mode: 'auto' }),
      hostOwnerOrganizationId: 'org_acme',
      organizations: {
        org_acme: {
          state: 'ready',
          policy: { kind: 'organization', organizationId: 'org_acme', document: { schemaVersion: 1, organization: { name: 'Acme' } } },
          hostPolicy: { kind: 'host', organizationId: 'org_acme', document: document('Acme', { mode: 'off' }) },
        },
      },
    }
    expect(updatePolicyOf(new HostPolicies(set)).managedMessage).toBeNull()
  })

  test('a managed state survives updater events until the policy changes', () => {
    // WHY: a late event from a check started before the policy arrived must not show an update the person cannot get.
    const managed = { kind: 'managed', message: 'Example Corp manages Solus updates.' } as const
    expect(reduceUpdateState(managed, { type: 'available', release: { version: '9.9.9', releaseNotes: null, releaseDate: null } })).toBe(managed)
    expect(reduceUpdateState(managed, { type: 'error', message: 'offline' })).toBe(managed)
  })
})

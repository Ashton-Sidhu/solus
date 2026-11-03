import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { PolicyApiResult } from '@solus/contracts/host-api'
import type { PolicyDocument } from '@solus/contracts/policy'
import type { HostPoliciesResponse, HostPolicySummary, OrganizationPolicyResponse, PolicyHost } from '@solus/contracts/policy-api'
import type { PolicyCloudRequests } from '@solus/client-core/settings-requests'
import {
  assignableHostPolicies,
  checkPolicyText,
  hostOwnerName,
  policyDifferences,
  policyText,
  readPolicy,
} from '@solus/workspace-ui/components/settings/policy/lib/policy-editor'
import { exportChoice, readImport } from '@solus/workspace-ui/components/settings/policy/lib/policy-document-editor'

// plans/030 §7, Settings → Policy: the editor refuses what the validator
// refuses, an import shows what it changes before it applies, a host owned by
// another organization takes only a policy without host settings, and a save
// that loses a race keeps the owner's text beside what the other owner saved.

mock.module('@solus/client-core/local-api', () => ({ localApi: {} }))

const globals = globalThis as unknown as { $state?: unknown }
let previousState: unknown
beforeEach(() => {
  previousState = globals.$state
  globals.$state = Object.assign(<T>(value: T) => value, { snapshot: <T>(value: T) => structuredClone(value) })
})
afterEach(() => {
  if (previousState === undefined) delete globals.$state
  else globals.$state = previousState
})

const acmeDocument: PolicyDocument = { schemaVersion: 1, organization: { name: 'Acme' }, sessions: { limits: { insights: { syncAll: true } } } }

describe('policy editor', () => {
  test('an organization policy with host settings is refused, as the cloud refuses it', () => {
    const text = JSON.stringify({ ...acmeDocument, host: { analyticsEnabled: false } })
    const checked = checkPolicyText(text, 'organization')
    expect(checked.ok).toBe(false)
    expect(checkPolicyText(text, 'host').ok).toBe(true)
    expect(checkPolicyText('{', 'mdm')).toMatchObject({ ok: false })
  })

  test('the difference lists each changed leaf', () => {
    const after: PolicyDocument = { ...acmeDocument, sessions: { limits: { insights: { syncAll: false }, maxPermissionMode: 'supervised' } } }
    expect(policyDifferences(acmeDocument, after)).toEqual([
      { path: 'sessions.limits.insights.syncAll', change: 'changed', before: 'true', after: 'false' },
      { path: 'sessions.limits.maxPermissionMode', change: 'added', after: '"supervised"' },
    ])
  })

  test('an import is checked against the kind of the editor, and compared with its text', () => {
    const imported = JSON.stringify({ ...acmeDocument, name: 'Laptops' })
    const pending = readImport('laptops.json', imported, checkPolicyText(policyText(acmeDocument), 'host'), 'host')
    expect(pending.ok && pending.differences.map((difference) => difference.path)).toEqual(['name'])
    expect(readImport('bad.json', '{"schemaVersion":2}', checkPolicyText('', 'host'), 'host').ok).toBe(false)
  })

  test('a document that fails the check exports nothing', () => {
    expect(exportChoice(checkPolicyText('{}', 'mdm'), 'json')).toEqual({ blocked: 'Fix the issues in this document first.' })
    expect('file' in exportChoice(checkPolicyText(JSON.stringify(acmeDocument), 'mdm'), 'powershell')).toBe(true)
  })

  test("a host owned by another organization takes only a host policy without host settings", () => {
    const policies: HostPolicySummary[] = [
      { policyId: 'p-host', name: 'Laptops', revision: 1, updatedAt: 1, hostIds: [], document: { ...acmeDocument, host: { analyticsEnabled: false } } },
      { policyId: 'p-sessions', name: 'Sessions only', revision: 1, updatedAt: 1, hostIds: [], document: acmeDocument },
    ]
    const owned: PolicyHost = { hostId: 'h', label: "Bob's laptop", policyId: null, hostOwner: { organizationId: 'globex', name: 'Globex' } }
    expect(assignableHostPolicies(owned, 'acme', policies).map((choice) => [choice.policyId, choice.blockedReason !== null])).toEqual([['p-host', true], ['p-sessions', false]])
    // The owner itself may assign either.
    expect(assignableHostPolicies(owned, 'globex', policies).every((choice) => choice.blockedReason === null)).toBe(true)
  })

  test('a cloud document this Solus version cannot decode keeps its text and is treated as unknown', () => {
    const newer = readPolicy({ revision: 3, document: { schemaVersion: 2, organization: { name: 'Acme' } } }, 'organization')
    expect(newer.document).toBeNull()
    expect(JSON.parse(newer.text)).toEqual({ schemaVersion: 2, organization: { name: 'Acme' } })
    const unknownPolicy: HostPolicySummary = { policyId: 'p-new', name: 'Newer', revision: 1, updatedAt: 1, hostIds: [], document: { schemaVersion: 2 } }
    const owned: PolicyHost = { hostId: 'h', label: 'Laptop', policyId: null, hostOwner: { organizationId: 'globex', name: 'Globex' } }
    expect(assignableHostPolicies(owned, 'acme', [unknownPolicy])[0]?.blockedReason).not.toBeNull()
  })

  test('with an MDM policy no organization manages the host settings', () => {
    const set = { mdm: null, hostOwnerOrganizationId: 'globex', organizations: {} }
    expect(hostOwnerName(set, [{ organizationId: 'globex', name: 'Globex' }])).toBe('Globex')
    const mdm = { kind: 'mdm' as const, organizationId: null, document: { schemaVersion: 1 as const, organization: { name: 'IT' } } }
    expect(hostOwnerName({ ...set, mdm }, [])).toBeNull()
  })
})

describe('policy store', () => {
  const organization = (revision: number, document: unknown = acmeDocument): OrganizationPolicyResponse => ({
    organizationId: 'acme', name: 'Acme', canManage: true, revision, document, updatedAt: revision,
  })
  const hostPolicies: HostPoliciesResponse = { organizationId: 'acme', canManage: true, policies: [], hosts: [] }

  function requests(overrides: Partial<PolicyCloudRequests>): PolicyCloudRequests {
    const ok = <Value>(value: Value) => async (): Promise<PolicyApiResult<Value>> => ({ kind: 'ok', value })
    return {
      organizationPolicyGet: ok(organization(4)),
      organizationPolicyPut: ok(organization(5)),
      hostPoliciesGet: ok(hostPolicies),
      hostPolicyCreate: async () => ({ kind: 'forbidden' }),
      hostPolicyPut: async () => ({ kind: 'forbidden' }),
      hostPolicyDelete: ok(null),
      hostPolicyAssign: async () => ({ kind: 'forbidden' }),
      hostPolicyUnassign: async () => ({ kind: 'forbidden' }),
      ...overrides,
    }
  }

  async function storeWith(port: PolicyCloudRequests) {
    const { PolicyStore } = await import('@solus/workspace-ui/components/settings/policy/policy.store.svelte')
    return new PolicyStore(() => port)
  }

  const target = { kind: 'organization' as const }

  test('an owner saves against the revision read, and a bad document never leaves the client', async () => {
    const sent: unknown[] = []
    const store = await storeWith(requests({
      organizationPolicyPut: async (_id, request) => {
        sent.push(request)
        return { kind: 'ok', value: organization(5, request.document) }
      },
    }))
    await store.load('https://solus.test', 'acme')
    store.edit('https://solus.test', 'acme', target, '{ "schemaVersion": 1 }')
    await store.save('https://solus.test', 'acme', target)
    expect(sent).toEqual([])
    expect(store.draftFor('https://solus.test', 'acme', target)?.error).toContain('organization')

    const next = { ...acmeDocument, sessions: { limits: { maxPermissionMode: 'supervised' } } }
    store.edit('https://solus.test', 'acme', target, policyText(next))
    await store.save('https://solus.test', 'acme', target)
    expect(sent).toEqual([{ expectedRevision: 4, document: next }])
  })

  test('a conflict keeps the text; the owner chooses theirs or keeps theirs own over the new revision', async () => {
    const theirs = { ...acmeDocument, name: 'Theirs' }
    const store = await storeWith(requests({ organizationPolicyPut: async () => ({ kind: 'conflict', revision: 9, document: theirs }) }))
    await store.load('https://solus.test', 'acme')
    const mine = policyText({ ...acmeDocument, name: 'Mine' })
    store.edit('https://solus.test', 'acme', target, mine)
    await store.save('https://solus.test', 'acme', target)
    const draft = store.draftFor('https://solus.test', 'acme', target)!
    expect(draft.conflict).toEqual({ revision: 9, document: theirs, text: policyText(theirs) })
    expect(draft.text).toBe(mine)
    // No edit while the conflict is open.
    store.edit('https://solus.test', 'acme', target, '{}')
    expect(draft.text).toBe(mine)

    store.resolveConflict('https://solus.test', 'acme', target, 'keep-mine')
    expect({ revision: draft.saved.revision, text: draft.text, conflict: draft.conflict }).toEqual({ revision: 9, text: mine, conflict: null })
  })

  test('a member reads the policy and cannot edit it', async () => {
    const store = await storeWith(requests({ organizationPolicyGet: async () => ({ kind: 'ok', value: { ...organization(4), canManage: false } }) }))
    await store.load('https://solus.test', 'acme')
    store.edit('https://solus.test', 'acme', target, '{}')
    expect(store.draftFor('https://solus.test', 'acme', target)?.text).toBe(policyText(acmeDocument))
  })

  test('losing ownership while editing shows forbidden', async () => {
    const store = await storeWith(requests({ organizationPolicyPut: async () => ({ kind: 'forbidden' }) }))
    await store.load('https://solus.test', 'acme')
    store.edit('https://solus.test', 'acme', target, policyText({ ...acmeDocument, name: 'x' }))
    await store.save('https://solus.test', 'acme', target)
    expect(store.viewFor('https://solus.test', 'acme')).toEqual({ status: 'forbidden' })
  })
})

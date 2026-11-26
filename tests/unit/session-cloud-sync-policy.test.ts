import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostPolicies, sessionCloudSyncSwitchState } from '@solus/contracts/host-policies'
import { sessionLimitsSchema, validatePolicyDocument, type PolicyDocument, type PolicySet } from '@solus/contracts/policy'

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
let settings: typeof import('@solus/server/host/settings')
let policy: typeof import('@solus/server/host/policy/host-policy-store')

const mdmDocument: PolicyDocument = {
  schemaVersion: 1, organization: { name: 'Example Corp' }, sessions: { limits: { sessionCloudSync: false } },
}
const organizationDocument: PolicyDocument = {
  schemaVersion: 1, organization: { name: 'Globex' }, sessions: { limits: { sessionCloudSync: false } },
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-session-cloud-sync-'))
  process.env.SOLUS_DATA_DIR = dataDir
  settings = await import('@solus/server/host/settings')
  policy = await import('@solus/server/host/policy/host-policy-store')
})

afterAll(() => {
  policy.useHostPolicyStore(new policy.HostPolicyStore({ mdm: null, standing: () => null }))
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

const actor = { accountId: 'person-1' }

describe.serial('session cloud sync gate', () => {
  test('default allows a signed-in person', () => {
    // WHY: a new host must save sessions when a person signs in.
    expect(policy.sessionCloudSyncDecision('local', actor)).toEqual({ allowed: true })
  })

  test('the host setting stops a Local session', () => {
    // WHY: the host owner must be able to stop upload without a policy.
    settings.setHostConfig({ sessionCloudSync: false })
    expect(policy.sessionCloudSyncDecision('local', actor)).toEqual({ allowed: false, reason: 'setting-off' })
    settings.setHostConfig({ sessionCloudSync: true })
  })

  test('MDM locks the switch and stops Local work', () => {
    // WHY: MDM applies even when a session belongs to no organization.
    policy.useHostPolicyStore(new policy.HostPolicyStore({ mdm: { source: 'test', document: mdmDocument, fingerprint: 'test' }, standing: () => null }))
    expect(policy.sessionCloudSyncDecision('local', actor)).toEqual({ allowed: false, reason: 'policy-forbids' })
    expect(() => settings.setHostConfig({ sessionCloudSync: true })).toThrow('managed by the MDM policy of Example Corp')
    expect(sessionCloudSyncSwitchState(policy.hostPolicies(), true)).toEqual({ checked: false, lockedBy: 'Save sessions to Solus Cloud is managed by the MDM policy of Example Corp.' })
    policy.useHostPolicyStore(new policy.HostPolicyStore({ mdm: null, standing: () => null }))
  })

  test('missing organization policy stops its work', () => {
    // WHY: a host cannot infer that an organization allows upload.
    expect(policy.sessionCloudSyncDecision('org-missing', actor)).toEqual({ allowed: false, reason: 'policy-not-available' })
  })

  test('one answer says why no conversation of a work leaves this host: the host switch, then the policy', () => {
    // WHY: the transcript rows, the turn diffs, the Insights texts, and the session
    // repository must follow one setting. If each asked its own question, a part of a
    // conversation could go to Solus Cloud when the organization keeps its sessions on hosts.
    const standing = (limits: { sessionCloudSync?: boolean }) => policy.useHostPolicyStore(new policy.HostPolicyStore({ mdm: null, standing: () => ({
      hostId: 'host-1', kind: 'personal', owner: null, hostOwnerOrganizationId: null, refreshedAt: 1,
      organizations: [{ organizationId: 'globex', name: 'Globex', shared: false, hostRules: { allowsCloudHosts: true, allowsPersonalHosts: true },
        policy: { schemaVersion: 1, organization: { name: 'Globex' }, sessions: { limits } }, hostPolicy: null }],
    }) }))
    try {
      standing({})
      expect(policy.sessionCloudCopyRefusal('globex')).toBeNull()
      expect(policy.sessionCloudCopyRefusal('local')).toBeNull()
      standing({ sessionCloudSync: false })
      expect(policy.sessionCloudCopyRefusal('globex')).toBe('policy-forbids')
      // The rule of one organization does not change the work of a person or of another organization.
      expect(policy.sessionCloudCopyRefusal('local')).toBeNull()
      // A host that has not received the policy cannot infer that the organization saves its sessions.
      expect(policy.sessionCloudCopyRefusal('org-missing')).toBe('policy-not-available')
      // The answer does not need a person: a published session with no owner follows it too.
      expect(policy.sessionCloudSyncDecision('globex', null)).toEqual({ allowed: false, reason: 'person-not-signed-in' })
      standing({})
      settings.setHostConfig({ sessionCloudSync: false })
      expect(policy.sessionCloudCopyRefusal('globex')).toBe('setting-off')
      expect(policy.sessionCloudCopyRefusal('local')).toBe('setting-off')
    } finally {
      settings.setHostConfig({ sessionCloudSync: true })
      policy.useHostPolicyStore(new policy.HostPolicyStore({ mdm: null, standing: () => null }))
    }
  })

  test('organization policy stops its work without locking the host-wide switch', () => {
    // WHY: an organization limit must not change the choice for Local work.
    const set: PolicySet = { mdm: null, hostOwnerOrganizationId: null, organizations: {
      globex: { state: 'ready', policy: { kind: 'organization', organizationId: 'globex', document: organizationDocument }, hostPolicy: null },
    } }
    const policies = new HostPolicies(set)
    expect(policies.forWork('globex').sessionCloudSync()?.value).toBe(false)
    expect(sessionCloudSyncSwitchState(policies, true)).toEqual({ checked: true, lockedBy: null })
    policy.useHostPolicyStore(new policy.HostPolicyStore({ mdm: null, standing: () => ({
      hostId: 'host-1', kind: 'personal', owner: null, hostOwnerOrganizationId: null, refreshedAt: 1,
      organizations: [{ organizationId: 'globex', name: 'Globex', shared: false,
        hostRules: { allowsCloudHosts: true, allowsPersonalHosts: true }, policy: organizationDocument, hostPolicy: null }],
    }) }))
    expect(policy.sessionCloudSyncDecision('globex', actor)).toEqual({ allowed: false, reason: 'policy-forbids' })
    expect(policy.sessionCloudSyncDecision('local', actor)).toEqual({ allowed: true })
    policy.useHostPolicyStore(new policy.HostPolicyStore({ mdm: null, standing: () => null }))
  })

  test('an old schema refuses the new key and the current schema accepts it', () => {
    // WHY: the console must wait until hosts understand this strict key.
    expect(sessionLimitsSchema.omit({ sessionCloudSync: true }).safeParse({ sessionCloudSync: false }).success).toBe(false)
    expect(validatePolicyDocument(mdmDocument, 'mdm').ok).toBe(true)
  })

  test('the switch shows on and off without a policy', () => {
    // WHY: the UI must show the saved host choice in both states.
    expect(sessionCloudSyncSwitchState(HostPolicies.none, true)).toEqual({ checked: true, lockedBy: null })
    expect(sessionCloudSyncSwitchState(HostPolicies.none, false)).toEqual({ checked: false, lockedBy: null })
  })
})

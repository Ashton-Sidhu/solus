import { describe, expect, test } from 'bun:test'
import { canonicalPolicyJson, REDACTED_LAUNCH_VALUE, validatePolicyDocument, type PolicyDocument } from '@solus/contracts/policy'
import type { HostPolicies } from '@solus/contracts/host-policies'
import { HostPolicyStore, PolicyRefusedError, enforce } from '@solus/server/host/policy/host-policy-store'
import type { HostStanding } from '@solus/server/host/organizations'
import type { MdmPolicy } from '@solus/server/host/policy/mdm-policy'

// plans/030-managed-policy.md: one policy.json schema for the MDM policy, cloud host
// policies, and organization policies. Work of an organization obeys the MDM policy,
// then its organization's host policy for this host, then its organization policy —
// never another organization's. A key in a policy is locked; a key in none is the
// person's own.

function doc(name: string, rest: Omit<PolicyDocument, 'schemaVersion' | 'organization'> = {}): PolicyDocument {
  return { schemaVersion: 1, organization: { name }, ...rest }
}

function mdm(document: PolicyDocument): MdmPolicy {
  return { source: '/etc/solus/policy.json', document, fingerprint: 'test' }
}

function standing(organizations: Array<{ id: string; name: string; policy: unknown; hostPolicy?: unknown }>, hostOwnerOrganizationId: string | null = null): HostStanding {
  return {
    hostId: 'H',
    category: 'personal',
    owner: null,
    refreshedAt: 0,
    hostOwnerOrganizationId,
    organizations: organizations.map((organization) => ({
      organizationId: organization.id,
      name: organization.name,
      shared: true,
      hostRules: { allowsCloudHosts: true, allowsPersonalHosts: true },
      policy: organization.policy,
      hostPolicy: organization.hostPolicy === undefined ? null : { policyId: `${organization.id}-host`, document: organization.hostPolicy },
    })),
  }
}

/** The policies a host holds with this MDM policy and standing, as the store builds them. */
function host(machine: PolicyDocument | null, hostStanding: HostStanding | null): HostPolicies {
  return new HostPolicyStore({ mdm: machine ? mdm(machine) : null, standing: () => hostStanding }).current()
}

describe('the policy document', () => {
  test('an unknown key is refused at every level: a key this build cannot enforce must not look enforced', () => {
    expect(validatePolicyDocument({ schemaVersion: 1, organization: { name: 'A' }, telemetry: false }, 'mdm').ok).toBe(false)
    expect(validatePolicyDocument({ schemaVersion: 1, organization: { name: 'A' }, sessions: { limits: { maxMode: 'plan' } } }, 'mdm').ok).toBe(false)
    expect(validatePolicyDocument({ schemaVersion: 1, organization: { name: 'A' }, host: { colour: 'red' } }, 'mdm').ok).toBe(false)
  })

  test('only settings the host enforces are manageable', () => {
    expect(validatePolicyDocument(doc('A', { sessions: { settings: { leadInstructions: 'Be careful.' } } }), 'organization').ok).toBe(true)
    expect(validatePolicyDocument({ schemaVersion: 1, organization: { name: 'A' }, sessions: { settings: { fontSize: 14 } } }, 'organization').ok).toBe(false)
  })

  test('an organization policy cannot hold host settings; a host policy and an MDM policy can', () => {
    const withHost = doc('A', { host: { analyticsEnabled: false } })
    expect(validatePolicyDocument(withHost, 'organization').ok).toBe(false)
    expect(validatePolicyDocument(withHost, 'host').ok).toBe(true)
    expect(validatePolicyDocument(withHost, 'mdm').ok).toBe(true)
  })

  test('rules that cross keys: a default above the ceiling, a locked model outside the allowlist, trust without remote access', () => {
    const above = validatePolicyDocument(doc('A', { sessions: { settings: { defaultPermissionMode: 'full-access' }, limits: { maxPermissionMode: 'supervised' } } }), 'mdm')
    expect(above.ok).toBe(false)
    const model = validatePolicyDocument(doc('A', { sessions: { settings: { textGenerationModel: { provider: 'codex', model: 'gpt-x' } }, limits: { models: { codex: ['gpt-y'] } } } }), 'mdm')
    expect(model.ok).toBe(false)
    const trust = validatePolicyDocument(doc('A', { host: { remoteAccess: false, trustLocalNetwork: true } }), 'mdm')
    expect(trust.ok).toBe(false)
  })

  test('the fingerprint input does not change with key order', () => {
    expect(canonicalPolicyJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalPolicyJson({ a: { c: 3, d: 2 }, b: 1 }))
  })
})

describe('resolution keyed by the work\'s organization', () => {
  const acmeHost = doc('Acme', { name: 'Acme laptops', host: { analyticsEnabled: false }, sessions: { limits: { maxPermissionMode: 'full-access' } } })
  const globexHost = doc('Globex', { name: 'Globex laptops', sessions: { limits: { maxPermissionMode: 'supervised' } } })
  const globex = doc('Globex', { sessions: { settings: { extraInstructions: 'Never push to main.' } } })
  const both = standing([
    { id: 'acme', name: 'Acme', policy: doc('Acme'), hostPolicy: acmeHost },
    { id: 'globex', name: 'Globex', policy: globex, hostPolicy: globexHost },
  ], 'acme')

  test('work of one organization never sees another organization\'s policies (the Bob case)', () => {
    // WHY: a host shared with Acme and Globex must not let Acme's host policy loosen Globex's limit.
    const policies = host(null, both)
    expect(policies.forWork('globex').ceiling()?.value).toBe('supervised')
    expect(policies.forWork('acme').ceiling()?.value).toBe('full-access')
    expect(() => enforce(policies.forWork('globex').runDenial({ mode: 'full-access', provider: 'claude-code' }))).toThrow(PolicyRefusedError)
    expect(policies.forWork('acme').runDenial({ mode: 'full-access', provider: 'claude-code' })).toBeNull()
  })

  test('the organization\'s host policy comes before its organization policy, and the MDM policy before both', () => {
    const policies = host(doc('IT', { sessions: { settings: { extraInstructions: 'MDM rules.' } } }), both)
    expect(policies.forWork('globex').withLocks({ extraInstructions: 'Mine.' }, ['extraInstructions']).extraInstructions).toBe('MDM rules.')
    expect(host(null, both).forWork('globex').withLocks({ extraInstructions: 'Mine.' }, ['extraInstructions']).extraInstructions).toBe('Never push to main.')
  })

  test('personal work sees only the MDM policy; without one it has no rule and keeps the person\'s values', () => {
    expect(host(null, both).forWork('local').ceiling()).toBeNull()
    expect(host(null, both).forWork('local').withLocks({ extraInstructions: 'Mine.' }, ['extraInstructions']).extraInstructions).toBe('Mine.')
    expect(host(doc('IT', { sessions: { limits: { maxPermissionMode: 'plan' } } }), both).forWork('local').ceiling()?.value).toBe('plan')
  })

  test('host keys come from the MDM policy, else the host-owning organization, else nobody', () => {
    expect(host(null, both).hostSetting('analyticsEnabled')?.value).toBe(false)
    expect(host(doc('IT', { host: { analyticsEnabled: true } }), both).hostSetting('analyticsEnabled')?.value).toBe(true)
    expect(host(null, standing([{ id: 'acme', name: 'Acme', policy: doc('Acme'), hostPolicy: acmeHost }], null)).hostSetting('analyticsEnabled')).toBeNull()
  })

  test('the person\'s preferences are never changed: locks are laid over a copy', () => {
    const sent = { extraInstructions: 'Mine.' }
    host(null, both).forWork('globex').withLocks(sent, ['extraInstructions'])
    expect(sent.extraInstructions).toBe('Mine.')
  })
})

describe('fail closed', () => {
  test('work of an organization this host has no policy for is refused, not run on defaults', () => {
    // WHY: the old registry answered defaults for an unknown organization, which allowed everything.
    expect(host(null, standing([])).forWork('globex').runDenial({ mode: 'plan', provider: 'codex' })?.message).toContain('has not received')
  })

  test('a policy this Solus version cannot decode refuses that organization\'s work and nobody else\'s', () => {
    const newer = standing([
      { id: 'acme', name: 'Acme', policy: { schemaVersion: 2, organization: { name: 'Acme' } } },
      { id: 'globex', name: 'Globex', policy: doc('Globex') },
    ])
    expect(host(null, newer).forWork('acme').runDenial({ mode: 'plan', provider: 'codex' })?.message).toContain('Update Solus')
    expect(host(null, newer).forWork('globex').runDenial({ mode: 'plan', provider: 'codex' })).toBeNull()
  })

  test('an undecodable policy of the host-owning organization stops all work on the host, personal work too', () => {
    const owned = standing([{ id: 'acme', name: 'Acme', policy: doc('Acme'), hostPolicy: { schemaVersion: 1, organization: { name: 'Acme' }, host: { unknown: true } } }], 'acme')
    expect(host(null, owned).forWork('local').runDenial({ mode: 'plan', provider: 'codex' })?.message).toContain('Update Solus')
  })
})

describe('limits', () => {
  const limited = standing([{ id: 'org', name: 'Org', policy: doc('Org', { sessions: { limits: { maxPermissionMode: 'accept-edits', providers: { allowed: ['claude-code'] }, models: { 'claude-code': ['claude-sonnet-5-5'] } } } }) }])

  test('a run above the ceiling is refused; a default or automatic grant is lowered to it', () => {
    const policies = host(null, limited)
    expect(policies.forWork('org').runDenial({ mode: 'auto', provider: 'claude-code' })?.message).toContain('limits sessions to Accept edits')
    expect(policies.forWork('org').clampMode('full-access')).toBe('accept-edits')
    expect(policies.forWork('org').clampMode('plan')).toBe('plan')
  })

  test('a provider or a model outside the allowlist is refused', () => {
    const policies = host(null, limited)
    expect(policies.forWork('org').runDenial({ mode: 'plan', provider: 'codex' })?.message).toContain('does not allow Codex')
    expect(policies.forWork('org').runDenial({ mode: 'plan', provider: 'claude-code', model: 'claude-opus-5-5' })?.message).toContain('does not allow the model')
    expect(policies.forWork('org').runDenial({ mode: 'plan', provider: 'claude-code', model: 'claude-sonnet-5-5' })).toBeNull()
  })

  test('under a ceiling the policy owns the launch config', () => {
    expect(host(null, limited).forWork('org').launch('claude-code').ownsLaunch).toBe(true)
    expect(host(null, standing([{ id: 'org', name: 'Org', policy: doc('Org') }])).forWork('org').launch('claude-code')).toEqual({ ownsLaunch: false, pin: null, source: null })
  })

  test('unverified webhooks: refused for an organization unless its policy allows them; personal ones only when the MDM policy says no', () => {
    const allowing = standing([{ id: 'org', name: 'Org', policy: doc('Org', { sessions: { limits: { webhooks: { allowUnverified: true } } } }) }, { id: 'quiet', name: 'Quiet', policy: doc('Quiet') }])
    expect(host(null, allowing).forWork('org').allowsUnverifiedWebhooks()).toBe(true)
    expect(host(null, allowing).forWork('quiet').allowsUnverifiedWebhooks()).toBe(false)
    expect(host(null, allowing).forWork('local').allowsUnverifiedWebhooks()).toBe(true)
    expect(host(doc('IT', { sessions: { limits: { webhooks: { allowUnverified: false } } } }), allowing).forWork('local').allowsUnverifiedWebhooks()).toBe(false)
  })

  test('clients get no launch pin values and no update feed: they can carry tokens', () => {
    const secret = doc('IT', { host: { updates: { mode: 'auto', feedUrl: 'https://token@updates.example.com/' } }, sessions: { limits: { providers: { launch: { 'claude-code': { environment: [{ name: 'API_KEY', value: 'secret' }] } } } } } })
    const summary = host(secret, null).summary().set
    expect(JSON.stringify(summary)).not.toContain('secret')
    expect(JSON.stringify(summary)).not.toContain('token@')
    expect(summary.mdm?.document.host?.updates?.mode).toBe('auto')
    // The pinned field's name stays, so an editor can lock exactly that field.
    expect(summary.mdm?.document.sessions?.limits?.providers?.launch?.['claude-code']?.environment).toEqual([{ name: 'API_KEY', value: REDACTED_LAUNCH_VALUE }])
  })
})

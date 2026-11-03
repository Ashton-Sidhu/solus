import { describe, expect, test } from 'bun:test'
import type { PolicyDocument, PolicySet, PolicySource } from '@solus/contracts/policy'
import type { HostOrganizationsStatus } from '@solus/contracts/organization-scope'
import {
  clampedDefaultMode,
  hostKeyLock,
  launchFieldsManaged,
  managedSettingLines,
  modelDenial,
  permissionModeDenial,
  providerDenial,
  sessionPolicy,
  settingLock,
  updatesManagedMessage,
} from '@solus/client-core/policy'
import { organizationRows } from '@solus/client-core/organization-rows'

// plans/030 §3: the policies of the organization that work belongs to apply to
// it, the MDM policy first; another organization's never do.

const opus = { provider: 'claude-code' as const, model: 'claude-opus-5-5', reasoningEffort: undefined }

function source(kind: PolicySource['kind'], organizationId: string | null, document: Omit<PolicyDocument, 'schemaVersion'>): PolicySource {
  return { kind, organizationId, document: { schemaVersion: 1, ...document } }
}

const mdm = source('mdm', null, { organization: { name: 'Example Corp' }, sessions: { limits: { maxPermissionMode: 'accept-edits' } } })
const acmeLaptops = source('host', 'acme', {
  organization: { name: 'Acme' },
  name: 'Acme laptops',
  host: { analyticsEnabled: false, updates: { mode: 'off' } },
  sessions: { limits: { maxPermissionMode: 'full-access' } },
})
const acme = source('organization', 'acme', { organization: { name: 'Acme' }, sessions: { limits: { insights: { syncAll: true } } } })
const globex = source('organization', 'globex', {
  organization: { name: 'Globex' },
  sessions: {
    settings: { leadModel: opus },
    limits: { maxPermissionMode: 'supervised', providers: { allowed: ['claude-code'] }, models: { 'claude-code': ['claude-opus-5-5'] } },
  },
})

const shared: PolicySet = {
  mdm: null,
  hostOwnerOrganizationId: 'acme',
  organizations: {
    acme: { state: 'ready', policy: acme, hostPolicy: acmeLaptops },
    globex: { state: 'ready', policy: globex, hostPolicy: null },
  },
}

describe('client policy resolver', () => {
  test("work of one organization never sees another organization's rules", () => {
    const acmeWork = sessionPolicy(shared, 'acme')
    const globexWork = sessionPolicy(shared, 'globex')
    expect(settingLock(acmeWork, 'leadModel', 'Lead model')).toBeNull()
    expect(settingLock(globexWork, 'leadModel', 'Lead model')?.message).toBe('Lead model is managed by Globex.')
    expect(permissionModeDenial(acmeWork, 'full-access')).toBeNull()
    expect(permissionModeDenial(globexWork, 'auto')).toBe('Globex limits sessions to Supervised.')
    expect(providerDenial(acmeWork, 'codex')).toBeNull()
    expect(providerDenial(globexWork, 'codex')).toBe('Globex does not allow Codex.')
  })

  test('personal work has no cloud rules, even on a host an organization manages', () => {
    const personal = sessionPolicy(shared, 'local')
    expect(personal.sources).toEqual([])
    expect(permissionModeDenial(personal, 'full-access')).toBeNull()
    // Host keys are machine-wide: the host-owning organization's still apply.
    expect(hostKeyLock(shared, 'analyticsEnabled', 'Analytics')?.value).toBe(false)
  })

  test('the MDM policy comes first for every organization and is all that personal work sees', () => {
    const set: PolicySet = { ...shared, mdm }
    expect(sessionPolicy(set, 'local').sources).toEqual([mdm])
    // Acme's host policy allows full access; the MDM ceiling wins.
    expect(permissionModeDenial(sessionPolicy(set, 'acme'), 'full-access')).toBe('The MDM policy of Example Corp limits sessions to Accept edits.')
    // With an MDM policy the host-owning organization's host section does not apply.
    expect(hostKeyLock(set, 'analyticsEnabled', 'Analytics')).toBeNull()
  })

  test('an organization this host has no policy for shows the refusal the host gives', () => {
    const work = sessionPolicy(shared, 'initech')
    expect(work.refusal?.code).toBe('POLICY_UNAVAILABLE')
    expect(permissionModeDenial(work, 'plan')).toBe(work.refusal!.message)
  })

  test('the default mode of a new tab is lowered to the ceiling, and a locked default wins', () => {
    const globexWork = sessionPolicy(shared, 'globex')
    expect(clampedDefaultMode(globexWork, 'full-access')).toBe('supervised')
    expect(clampedDefaultMode(globexWork, 'plan')).toBe('plan')
    const locked = sessionPolicy({ ...shared, mdm: source('mdm', null, { organization: { name: 'IT' }, sessions: { settings: { defaultPermissionMode: 'plan' } } }) }, 'local')
    expect(clampedDefaultMode(locked, 'auto')).toBe('plan')
  })

  test('a model limit applies to the named provider only', () => {
    const globexWork = sessionPolicy(shared, 'globex')
    expect(modelDenial(globexWork, 'claude-code', 'claude-opus-5-5')).toBeNull()
    expect(modelDenial(globexWork, 'claude-code', 'claude-haiku-5-5')).toBe('Globex does not allow the model claude-haiku-5-5.')
    expect(modelDenial(sessionPolicy(shared, 'acme'), 'codex', 'gpt-5')).toBeNull()
  })

  test('settings pages name each organization that locks a key, and MDM locks it for all work', () => {
    const organizations = [{ organizationId: 'acme', name: 'Acme' }, { organizationId: 'globex', name: 'Globex' }]
    expect(managedSettingLines(shared, organizations, 'leadModel', (value) => (value ? 'Opus' : 'the default'))).toEqual({
      lockedEverywhere: false,
      lines: ['Globex sessions use Opus (managed).'],
    })
    const set: PolicySet = { ...shared, mdm: source('mdm', null, { organization: { name: 'IT' }, sessions: { settings: { leadModel: opus } } }) }
    expect(managedSettingLines(set, organizations, 'leadModel', () => 'Opus').lockedEverywhere).toBe(true)
  })

  test('updates and launch fields say who manages them', () => {
    expect(updatesManagedMessage(shared)).toBe('Acme manages Solus updates.')
    expect(launchFieldsManaged(sessionPolicy(shared, 'globex'))?.message).toBe('Globex sets how agents start. Your launch settings do not apply.')
    expect(launchFieldsManaged(sessionPolicy(shared, 'local'))).toBeNull()
  })
})

describe('organization rows', () => {
  const status: HostOrganizationsStatus = {
    registered: true,
    hostId: 'host-bob',
    apiUrl: null,
    category: 'personal',
    owner: null,
    organizations: [
      { organizationId: 'acme', name: 'Acme', shared: false, hostRules: { allowsCloudHosts: true, allowsPersonalHosts: true } },
      { organizationId: 'globex', name: 'Globex', shared: false, hostRules: { allowsCloudHosts: true, allowsPersonalHosts: false } },
    ],
    insightsOptIn: ['globex'],
    attachedAt: null,
    delivery: [],
    deliveryError: null,
  }

  test('Insights are managed only where the organization policy syncs all of them', () => {
    const rows = organizationRows(status, shared)
    expect(rows.map((row) => [row.organizationId, row.insightsManaged, row.insightsOptedIn])).toEqual([['acme', true, false], ['globex', false, true]])
  })

  test('before the policy is read nothing is managed by it, and personal hosts follow the host rules', () => {
    const rows = organizationRows(status, null)
    expect(rows.map((row) => row.insightsManaged)).toEqual([false, false])
    expect(rows.map((row) => row.personalHostsNotAllowed)).toEqual([false, true])
  })
})

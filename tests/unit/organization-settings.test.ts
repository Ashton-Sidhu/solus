import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { PolicyApiResult } from '@solus/contracts/host-api'
import { organizationSettingsPath, type OrganizationSettingsPatchRequest, type OrganizationSettingsResponse } from '@solus/contracts/policy-api'
import { settingsCloudRequests, type PolicyCloudRequests, type SettingsHttpRequest } from '@solus/client-core/settings-requests'
import { changedHostRules, packagesFromText } from '@solus/workspace-ui/components/settings/organization/lib/organization-settings'

// Settings → Organization: every member reads the organization; only an owner
// changes it, and a save never overwrites another owner's newer save unseen.

mock.module('@solus/client-core/local-api', () => ({ localApi: {} }))

// The store is a `.svelte.ts` module; outside the compiler `$state` is the value itself.
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

const ORIGIN = 'https://solus.test'

function settings(role: 'owner' | 'member', change: Partial<OrganizationSettingsResponse> = {}): OrganizationSettingsResponse {
  return {
    organizationId: 'acme',
    name: 'Acme',
    slug: 'acme',
    role,
    members: [{ userId: 'u1', name: 'Olive', email: 'olive@acme.test', image: null, role: 'owner' }],
    hostRules: { allowCloudHosts: true, allowPersonalHosts: true, defaultPackages: [], defaultSetupScript: null },
    hostRulesRevision: 3,
    ...change,
  }
}

function requests(read: OrganizationSettingsResponse, write: (request: OrganizationSettingsPatchRequest) => PolicyApiResult<OrganizationSettingsResponse>) {
  const sent: OrganizationSettingsPatchRequest[] = []
  const forbidden = async () => ({ kind: 'forbidden' as const })
  const port: PolicyCloudRequests = {
    organizationPolicyGet: forbidden,
    organizationPolicyPut: forbidden,
    hostPoliciesGet: forbidden,
    hostPolicyCreate: forbidden,
    hostPolicyPut: forbidden,
    hostPolicyDelete: forbidden,
    hostPolicyAssign: forbidden,
    hostPolicyUnassign: forbidden,
    organizationSettingsGet: async () => ({ kind: 'ok', value: read }),
    organizationSettingsPatch: async (_id, request) => {
      sent.push(request)
      return write(request)
    },
  }
  return { port, sent }
}

async function storeWith(port: PolicyCloudRequests) {
  const { OrganizationSettingsStore } = await import('@solus/workspace-ui/components/settings/organization/organization-settings.store.svelte')
  const store = new OrganizationSettingsStore(() => port)
  await store.load(ORIGIN, 'acme')
  return store
}

const readySettings = (store: { viewFor(origin: string, id: string): unknown }) => {
  const view = store.viewFor(ORIGIN, 'acme') as { status: string; settings: OrganizationSettingsResponse; saveError: string | null }
  expect(view.status).toBe('ready')
  return view
}

describe('the organization settings store', () => {
  test('a member reads the settings and no write leaves the client', async () => {
    const { port, sent } = requests(settings('member'), () => ({ kind: 'ok', value: settings('member') }))
    const store = await storeWith(port)
    expect(await store.rename(ORIGIN, 'acme', 'Mine')).toBe(false)
    expect(await store.saveHostRules(ORIGIN, 'acme', { ...settings('member').hostRules, allowCloudHosts: false })).toBe(false)
    expect(sent).toEqual([])
    expect(readySettings(store).settings.name).toBe('Acme')
  })

  test('an owner saves host rules against the revision that was read', async () => {
    const rules = { ...settings('owner').hostRules, allowPersonalHosts: false }
    const { port, sent } = requests(settings('owner'), () => ({ kind: 'ok', value: settings('owner', { hostRules: rules, hostRulesRevision: 4 }) }))
    const store = await storeWith(port)
    expect(await store.saveHostRules(ORIGIN, 'acme', rules)).toBe(true)
    expect(sent).toEqual([{ hostRules: rules, expectedRevision: 3 }])
    expect(readySettings(store).settings.hostRulesRevision).toBe(4)
    // Saving what is already there sends nothing.
    expect(await store.saveHostRules(ORIGIN, 'acme', rules)).toBe(false)
    expect(sent).toHaveLength(1)
  })

  test("a conflict shows the other owner's settings and says nothing was saved", async () => {
    const theirs = settings('owner', { hostRules: { ...settings('owner').hostRules, allowCloudHosts: false }, hostRulesRevision: 4 })
    const { port } = requests(settings('owner'), () => ({ kind: 'conflict', revision: 4, document: theirs }))
    const store = await storeWith(port)
    expect(await store.saveHostRules(ORIGIN, 'acme', { ...settings('owner').hostRules, defaultPackages: ['ripgrep'] })).toBe(false)
    const view = readySettings(store)
    expect(view.settings).toEqual(theirs)
    expect(view.saveError).toContain('Another owner saved first')
  })

  test('a rename is trimmed, and an unchanged name sends nothing', async () => {
    const { port, sent } = requests(settings('owner'), (request) => ({ kind: 'ok', value: settings('owner', { name: request.name ?? 'Acme' }) }))
    const store = await storeWith(port)
    expect(await store.rename(ORIGIN, 'acme', '  Acme  ')).toBe(false)
    expect(await store.rename(ORIGIN, 'acme', ' Acme Labs ')).toBe(true)
    expect(sent).toEqual([{ name: 'Acme Labs' }])
  })
})

describe('organization settings requests', () => {
  test('read and write the settings path, and decode a 409 as a conflict', async () => {
    const sent: SettingsHttpRequest[] = []
    const answers = [Response.json(settings('owner')), Response.json({ error: 'policy_conflict', revision: 4, document: settings('owner') }, { status: 409 })]
    const port = settingsCloudRequests(async (request) => {
      sent.push(request)
      return answers.shift() ?? null
    })
    expect(await port.organizationSettingsGet('acme')).toEqual({ kind: 'ok', value: settings('owner') })
    const patch = { hostRules: settings('owner').hostRules, expectedRevision: 3 }
    expect((await port.organizationSettingsPatch('acme', patch)).kind).toBe('conflict')
    expect(sent).toEqual([
      { method: 'GET', path: organizationSettingsPath('acme') },
      { method: 'PATCH', path: organizationSettingsPath('acme'), body: patch },
    ])
  })
})

describe('host rules as an owner types them', () => {
  test('packages split on spaces and commas, each once; a blank script is no script', () => {
    expect(packagesFromText(' ripgrep, jq  ripgrep ')).toEqual(['ripgrep', 'jq'])
    const rules = settings('owner').hostRules
    expect(changedHostRules(rules, { defaultSetupScript: '   ' }).defaultSetupScript).toBeNull()
    expect(changedHostRules(rules, { defaultSetupScript: 'apt update' }).defaultSetupScript).toBe('apt update')
  })
})

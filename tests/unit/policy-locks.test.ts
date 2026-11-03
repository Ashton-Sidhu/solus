import { describe, expect, test } from 'bun:test'
import { clampedDefaultMode, permissionModeDenial, sessionPolicy } from '@solus/client-core/policy'
import type { PolicyDocument, PolicySet, PolicySource } from '@solus/contracts/policy'
import { PERMISSION_MODES } from '@solus/contracts/types'
import { modelPolicyDenial, withProviderPolicy } from '../../packages/workspace-ui/src/components/pickers/lib/policy-locks'
import { implementationMode } from '../../packages/workspace-ui/src/contexts/workspace/session-plan-operations'
import { managedSettingNote } from '../../packages/workspace-ui/src/components/settings/policy/lib/managed-setting-note'
import { hostLockNote, pairingLockNote, solusToolsLock } from '../../packages/workspace-ui/src/components/settings/policy/lib/host-locks'

const GLOBEX = 'org-globex'
const INITECH = 'org-initech'

function source(kind: PolicySource['kind'], document: Omit<PolicyDocument, 'schemaVersion'>, organizationId: string | null): PolicySource {
  return { kind, organizationId, document: { schemaVersion: 1, ...document } }
}

const globexPolicy = source('organization', {
  organization: { name: 'Globex' },
  sessions: {
    settings: { leadModel: { provider: 'claude-code', model: 'model-x', reasoningEffort: undefined } },
    limits: { maxPermissionMode: 'accept-edits', providers: { allowed: ['claude-code'] }, models: { 'claude-code': ['model-x'] } },
  },
}, GLOBEX)

const set: PolicySet = {
  mdm: null,
  hostOwnerOrganizationId: null,
  organizations: {
    [GLOBEX]: { state: 'ready', policy: globexPolicy, hostPolicy: null },
    [INITECH]: { state: 'unavailable' },
  },
}

const organizations = [
  { organizationId: GLOBEX, name: 'Globex' },
  { organizationId: INITECH, name: 'Initech' },
]

const rows = [
  { id: 'claude-code' as const, label: 'Claude Code', enabled: true, reason: '' },
  { id: 'codex' as const, label: 'Codex', enabled: true, reason: '' },
]

describe('permission-mode picker locks', () => {
  test('modes above the ceiling are disabled with the ceiling message; the rest stay open', () => {
    const policy = sessionPolicy(set, GLOBEX)
    const denied = PERMISSION_MODES.filter((mode) => permissionModeDenial(policy, mode) !== null)
    expect(denied.sort()).toEqual(['auto', 'full-access'])
    expect(permissionModeDenial(policy, 'full-access')).toBe('Globex limits sessions to Accept edits.')
  })

  test('personal work under no MDM policy locks no mode', () => {
    const policy = sessionPolicy(set, 'local')
    expect(PERMISSION_MODES.every((mode) => permissionModeDenial(policy, mode) === null)).toBe(true)
  })

  test('work whose policy the host has not received refuses every mode with the host words', () => {
    const policy = sessionPolicy(set, INITECH)
    expect(permissionModeDenial(policy, 'plan')).toContain('has not received')
  })
})

describe('provider and model picker locks', () => {
  test('an agent outside the allowlist is disabled and says the policy refuses it', () => {
    const [claude, codex] = withProviderPolicy(rows, sessionPolicy(set, GLOBEX))
    expect(claude).toMatchObject({ enabled: true, policyDenial: null })
    expect(codex).toMatchObject({ enabled: false, policyDenial: 'Globex does not allow Codex.', reason: 'Globex does not allow Codex.' })
  })

  test('no known host locks no agent', () => {
    expect(withProviderPolicy(rows, null).every((row) => row.enabled && row.policyDenial === null)).toBe(true)
  })

  test('a model outside the allowlist is refused; Auto is never refused', () => {
    const policy = sessionPolicy(set, GLOBEX)
    expect(modelPolicyDenial(policy, 'claude-code', 'model-x')).toBeNull()
    expect(modelPolicyDenial(policy, 'claude-code', 'model-y')).toBe('Globex does not allow the model model-y.')
    expect(modelPolicyDenial(policy, 'codex', 'gpt-x')).toBe('Globex does not allow Codex.')
    expect(modelPolicyDenial(policy, 'claude-code', 'auto')).toBeNull()
  })
})

describe('default mode of new work', () => {
  test('the person default is lowered to the ceiling', () => {
    expect(clampedDefaultMode(sessionPolicy(set, GLOBEX), 'full-access')).toBe('accept-edits')
    expect(clampedDefaultMode(sessionPolicy(set, 'local'), 'full-access')).toBe('full-access')
  })

  test('an approved plan runs at most at the ceiling, in both approval modes', () => {
    const policy = sessionPolicy(set, GLOBEX)
    expect(implementationMode('default', 'full-access', policy)).toBe('accept-edits')
    expect(implementationMode('default', 'plan', policy)).toBe('accept-edits')
    expect(implementationMode('supervised', 'full-access', policy)).toBe('supervised')
    const planOnly = sessionPolicy({ ...set, mdm: source('mdm', { organization: { name: 'Example Corp' }, sessions: { limits: { maxPermissionMode: 'plan' } } }, null) }, 'local')
    expect(implementationMode('supervised', undefined, planOnly)).toBe('plan')
  })

  test('without a policy an approved plan keeps the old rule', () => {
    const policy = sessionPolicy(set, 'local')
    expect(implementationMode('default', undefined, policy)).toBe('full-access')
    expect(implementationMode('default', 'plan', policy)).toBe('full-access')
    expect(implementationMode('default', 'auto', policy)).toBe('auto')
  })
})

describe('managed setting notes', () => {
  test('each organization that locks a key gives one line; the control stays open', () => {
    expect(managedSettingNote(set, organizations, 'leadModel')).toEqual({ lockedEverywhere: false, lines: ['Globex sessions use model-x (managed).'] })
    expect(managedSettingNote(set, organizations, 'reviewModel')).toEqual({ lockedEverywhere: false, lines: [] })
  })

  test('an MDM key is locked for all work on the host', () => {
    const mdmSet = { ...set, mdm: source('mdm', { organization: { name: 'Example Corp' }, sessions: { settings: { defaultPermissionMode: 'supervised' } } }, null) }
    expect(managedSettingNote(mdmSet, organizations, 'defaultPermissionMode')).toEqual({
      lockedEverywhere: true,
      lines: ['All sessions on this host use Supervised by default (the MDM policy of Example Corp).'],
    })
  })
})

describe('host key locks', () => {
  const hostSet: PolicySet = {
    mdm: source('mdm', { organization: { name: 'Example Corp' }, host: { remoteAccess: false, solusTools: { send_session: false } } }, null),
    hostOwnerOrganizationId: null,
    organizations: {},
  }

  test('a locked host key names its source and makes the control inert', () => {
    expect(hostLockNote(hostSet, 'remoteAccess')).toEqual({ lockedEverywhere: true, lines: ['Remote access is managed by the MDM policy of Example Corp.'] })
    expect(hostLockNote(hostSet, 'cloudTunnel')).toBeUndefined()
  })

  test('pairing locks only when remote access is off', () => {
    expect(pairingLockNote(hostSet)?.lines).toEqual(['Pairing is managed by the MDM policy of Example Corp.'])
    const open = { ...hostSet, mdm: source('mdm', { organization: { name: 'Example Corp' }, host: { remoteAccess: true } }, null) }
    expect(pairingLockNote(open)).toBeUndefined()
  })

  test('only the Solus tools a policy names are locked', () => {
    const lock = solusToolsLock(hostSet)
    expect(lock?.message).toBe('1 Solus tool is managed by the MDM policy of Example Corp.')
    expect([...(lock?.lockedTools ?? [])]).toEqual(['send_session'])
  })
})

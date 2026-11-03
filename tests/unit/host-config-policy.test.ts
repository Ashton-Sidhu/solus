import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PolicyDocument } from '@solus/contracts/policy'

// plans/030 §6.6 and §6.7: a host key a policy locks is laid over the owner's
// config when it is read, a write to it is refused, and the stored file never
// holds the policy's value — removing the policy brings the owner's value back.

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
let settings: typeof import('@solus/server/host/settings')
let policy: typeof import('@solus/server/host/policy/policy-gate')

const LOCKS: PolicyDocument = {
  schemaVersion: 1,
  organization: { name: 'Example Corp' },
  host: { analyticsEnabled: false, remoteAccess: false, archivedAutomationRetentionDays: 7 },
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-host-config-policy-'))
  process.env.SOLUS_DATA_DIR = dataDir
  settings = await import('@solus/server/host/settings')
  policy = await import('@solus/server/host/policy/policy-gate')
})

afterAll(() => {
  policy.usePolicyGate(new policy.PolicyGate({ mdm: null, standing: () => null }))
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

describe('host settings under a policy', () => {
  test('a locked key reads as the policy says, refuses a write, and is never written to the file', () => {
    settings.setHostConfig({ analyticsEnabled: true, archivedAutomationRetentionDays: 30 })
    settings.setRemoteAccess(true)
    policy.usePolicyGate(new policy.PolicyGate({ mdm: { source: '/etc/solus/policy.json', document: LOCKS, fingerprint: 'test' }, standing: () => null }))

    expect(settings.getHostConfig().config.analyticsEnabled).toBe(false)
    expect(settings.getHostConfig().config.archivedAutomationRetentionDays).toBe(7)
    expect(settings.effectiveRemoteAccess()).toBe(false)
    // Without remote access, local network trust is off too.
    expect(settings.effectiveTrustLocalNetwork()).toBe(false)

    expect(() => settings.setHostConfig({ analyticsEnabled: true })).toThrow('managed by the MDM policy of Example Corp')
    expect(() => settings.setRemoteAccess(true)).toThrow('managed by')
    // A key the policy does not lock stays the owner's to change, and the write keeps the owner's own locked values.
    settings.setHostConfig({ unfiledRecordingRetentionDays: 9 })
    const stored = JSON.parse(readFileSync(join(dataDir, 'server-settings.json'), 'utf8'))
    expect(stored.hostConfig.analyticsEnabled).toBe(true)
    expect(stored.hostConfig.archivedAutomationRetentionDays).toBe(30)
    expect(stored.hostConfig.unfiledRecordingRetentionDays).toBe(9)

    // Removing the policy brings the owner's values back.
    policy.usePolicyGate(new policy.PolicyGate({ mdm: null, standing: () => null }))
    expect(settings.getHostConfig().config.analyticsEnabled).toBe(true)
    expect(settings.effectiveRemoteAccess()).toBe(true)
  })
})

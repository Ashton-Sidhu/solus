import { expect, test } from 'bun:test'
import type { ProviderUpdateStatus } from '@solus/contracts/host-update-types'
import { providerCheckText, providerUpdateDetail } from '@solus/client-core/provider-update-text'
import { providerUpdateRows } from '@solus/workspace-ui/components/connections/lib/host-update-rows'

const provider: ProviderUpdateStatus = {
  agent: 'codex', installedVersion: '0.170.0', check: { kind: 'available', latestVersion: '0.171.0', checkedAt: 123 },
  installation: { method: 'native', managed: true, path: '/host/agents/codex', source: 'mirror', canUpdate: true, automatic: true, remediation: null },
}

test('every client can show the actual host installation and approved source', () => {
  expect(providerUpdateDetail(provider)).toContain('/host/agents/codex')
  expect(providerUpdateDetail(provider)).toContain('Automatic updates on')
  expect(providerUpdateDetail(provider)).toContain('Approved mirror')
})

test('a failed check reports uncertainty without saying the working agent is broken', () => {
  const text = providerCheckText({ ...provider, check: { kind: 'error', message: 'Source unavailable', latestVersion: '0.171.0', checkedAt: 123 } })
  expect(text).toContain('Cannot check for updates')
  expect(text).toContain('Last known release: 0.171.0')
})

test('an automatic update started by another client disables duplicate update actions', () => {
  const rows = providerUpdateRows([{ id: 'codex', label: 'Codex', state: 'done', detail: 'Installed and signed in' }], [
    { ...provider, update: { phase: 'verifying', version: '0.171.0', message: null, updatedAt: 123 } },
  ], () => { throw new Error('must not start another update') })
  expect(rows[0]?.state).toBe('busy')
  expect(rows[0]?.detail).toContain('Verifying update')
  expect(rows[0]?.update).toBeUndefined()
})

test('package-manager installations show their manual command without offering the wrong updater', () => {
  const rows = providerUpdateRows([{ id: 'codex', label: 'Codex', state: 'done', detail: 'Installed and signed in' }], [
    { ...provider, installation: { method: 'npm', managed: false, canUpdate: false, automatic: false, path: '/host/npm/codex', remediation: 'Run npm install -g @openai/codex on this host.', source: 'npm' } },
  ], () => { throw new Error('must not use the native updater') })
  expect(rows[0]?.update).toBeUndefined()
  expect(rows[0]?.detail).toContain('Run npm install -g')
})

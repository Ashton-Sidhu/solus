import { expect, test } from 'bun:test'
import { sshDeviceHostConfigSchema } from '@solus/contracts/device-types'
import { sshHostDraftConfig } from '../../packages/workspace-ui/src/components/devices/lib/device-host-draft'
import { shownToolVersion } from '../../packages/workspace-ui/src/components/devices/lib/device-settings'

// Saving a host with an id that exists replaces that host, so a new host's
// id, which the page makes from its name, must never take an id in use.
test('a new SSH device host never takes the id of a host that exists', () => {
  const draft = { label: 'Studio Mac', target: 'me@studio', port: '', identityFile: '' }
  expect(sshHostDraftConfig(draft, ['local']).id).toBe('studio-mac')
  expect(sshHostDraftConfig(draft, ['local', 'studio-mac', 'studio-mac-2']).id).toBe('studio-mac-3')
  expect(sshHostDraftConfig({ ...draft, label: 'Local' }, ['local']).id).toBe('local-host')
  expect(sshDeviceHostConfigSchema.safeParse(sshHostDraftConfig({ ...draft, label: '' }, [])).success).toBe(true)
})

test('a tool chip names the running version, then the required one, then the newest installed', () => {
  expect(shownToolVersion({ requiredVersion: '0.11.0', installedVersions: ['0.11.0'], runningVersion: '0.10.0' })).toBe('0.10.0')
  expect(shownToolVersion({ requiredVersion: '0.11.0', installedVersions: ['0.9.0', '0.11.0'], runningVersion: null })).toBe('0.11.0')
  expect(shownToolVersion({ requiredVersion: '0.12.0', installedVersions: ['0.9.0', '0.10.0'], runningVersion: null })).toBe('0.10.0')
  expect(shownToolVersion({ requiredVersion: '0.12.0', installedVersions: [], runningVersion: null })).toBeNull()
})

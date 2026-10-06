import { expect, test } from 'bun:test'
import type { DeviceBuild } from '@solus/contracts/device-types'
import { buildDetails } from '@solus/client-core/device-builds'

/**
 * A build's … menu says what the build is in labeled rows, so a person can
 * tell two builds of one app apart. The row already names the build and its
 * kind and age, so the menu does not repeat them.
 */

const build: DeviceBuild = { buildId: 'b1', platform: 'ios', runsOn: 'simulator', appId: 'sh.solus.mobile', name: 'Solus.app', sessionId: 's1', sizeBytes: 3 * 1024 * 1024, createdAt: 0, assetId: null, lastInstall: null }

test('the menu names the app, size, project, conversation and last install', () => {
  const now = 49 * 60_000
  const rows = buildDetails({ ...build, lastInstall: { deviceHostId: 'local', deviceId: 'SIM-1', deviceName: 'iPhone 17', installedAt: 0 } }, now, {
    projectPath: '/Users/me/code/solus/',
    conversationTitle: 'T3code Mobile Agent Cards',
  })
  expect(rows).toEqual([
    { label: 'App ID', value: 'sh.solus.mobile' },
    { label: 'Size', value: '3.0 MB' },
    { label: 'Project', value: 'solus' },
    { label: 'Conversation', value: 'T3code Mobile Agent Cards' },
    { label: 'Installed', value: 'iPhone 17 · 49m' },
  ])
})

test('what the client does not know is left out, not guessed', () => {
  expect(buildDetails({ ...build, appId: null }, 0).map((row) => row.label)).toEqual(['App ID', 'Size'])
  expect(buildDetails({ ...build, appId: null }, 0)[0]!.value).toBe('Unknown')
})

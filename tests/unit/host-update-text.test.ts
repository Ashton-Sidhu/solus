import { expect, test } from 'bun:test'
import { updateCheckFailureText } from '@solus/client-core/host-update-text'
import { updateStatusText } from '../../apps/mobile/src/features/settings/lib/update-status'
import type { HostUpdateStatus, UpdateCheckState } from '@solus/contracts/host-update-types'

const failed = (message: string): UpdateCheckState => ({ kind: 'error', message, latestVersion: '2.0.0', checkedAt: 0 })

test('update feedback names every failed check and its reason', () => {
  const status: HostUpdateStatus = {
    currentVersion: '1.0.0', install: 'managed', remediation: null, releaseUrl: null,
    check: failed('Release server unavailable'),
    providers: [
      { agent: 'claude', installedVersion: '1.0.0', check: failed('Registry request timed out') },
      { agent: 'codex', installedVersion: '1.0.0', check: failed('Invalid release response') },
    ],
  }
  const details = 'Solus: Release server unavailable\nClaude Code: Registry request timed out\nCodex: Invalid release response'
  expect(updateCheckFailureText(status)).toBe(details)
  expect(updateStatusText(status)).toBe(details)
})

test('a provider failure is visible when the Solus check passed', () => {
  const status = {
    install: 'managed' as const, check: { kind: 'up-to-date' as const, checkedAt: 0 },
    providers: [{ agent: 'codex' as const, installedVersion: '1.0.0', check: failed('Registry unavailable') }],
  }
  expect(updateCheckFailureText(status)).toBe('Codex: Registry unavailable')
  expect(updateStatusText(status)).toBe('Codex: Registry unavailable')
})

test('successful and skipped checks do not produce failure details', () => {
  expect(updateCheckFailureText({ check: { kind: 'up-to-date', checkedAt: 0 }, providers: [
    { agent: 'claude', installedVersion: null, check: { kind: 'idle', reason: 'Not installed' } },
  ] })).toBeNull()
})

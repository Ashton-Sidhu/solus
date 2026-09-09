import { expect, test } from 'bun:test'
import { parseProviderVersion } from '@solus/server/updates/provider-versions'

test('version output is parsed without treating the product label as a version', () => {
  expect(parseProviderVersion('1.0.98 (Claude Code)\n')).toBe('1.0.98')
  expect(parseProviderVersion('codex-cli 0.42.0')).toBe('0.42.0')
  expect(parseProviderVersion('')).toBeNull()
  expect(parseProviderVersion('permission denied')).toBeNull()
})

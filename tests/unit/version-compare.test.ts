import { expect, test } from 'bun:test'
import { compareVersions } from '@solus/contracts/version'

test('release tags and unequal part counts compare numerically', () => {
  expect(compareVersions(' v1.2.0 ', '1.2')).toBe(0)
  expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0)
  expect(compareVersions('v0.30.0', '0.31.0')).toBeLessThan(0)
})

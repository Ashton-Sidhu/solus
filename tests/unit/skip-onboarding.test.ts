import { describe, expect, test } from 'bun:test'
import { skipsOnboarding } from '@solus/workspace-ui/components/onboarding/lib/skip-onboarding'

describe('onboarding launch flag', () => {
  test('skips only when the explicit flag is present', () => {
    expect(skipsOnboarding('?skip-onboarding')).toBe(true)
    expect(skipsOnboarding('?session=one&skip-onboarding')).toBe(true)
    expect(skipsOnboarding('')).toBe(false)
    expect(skipsOnboarding('?session=one')).toBe(false)
  })
})

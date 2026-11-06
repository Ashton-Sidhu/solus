import { describe, expect, test } from 'bun:test'
import { BROWSER_GUEST_MARK_SCRIPT } from '@solus/server/browser/guest-mark'
import { skipsOnboarding } from '@solus/workspace-ui/components/onboarding/lib/skip-onboarding'

const browserGuest = (): { __solusBrowserGuest?: boolean } => {
  const page = {}
  new Function('window', BROWSER_GUEST_MARK_SCRIPT)(page)
  return page
}

describe('onboarding launch flag', () => {
  test('skips only when the explicit flag is present', () => {
    expect(skipsOnboarding('?skip-onboarding', {})).toBe(true)
    expect(skipsOnboarding('?session=one&skip-onboarding', {})).toBe(true)
    expect(skipsOnboarding('', {})).toBe(false)
    expect(skipsOnboarding('?session=one', {})).toBe(false)
  })
})

describe('onboarding in the Solus browser', () => {
  test('a page the browser host marked skips it with no flag', () => {
    expect(skipsOnboarding('', browserGuest())).toBe(true)
  })

  test('an agent checking the flow can still ask for it', () => {
    expect(skipsOnboarding('?show-onboarding', browserGuest())).toBe(false)
  })

  test('the show flag does not open onboarding outside the browser host', () => {
    expect(skipsOnboarding('?show-onboarding', {})).toBe(false)
  })
})

import { describe, expect, test } from 'bun:test'
import { dispatchAvailability } from '../../src/renderer/components/servers/lib/dispatch-availability'

describe('dispatch availability', () => {
  test('a checkout with no remote cannot be dispatched', () => {
    // WHY: dispatch carries the repository, not the working tree — the target
    // host gets the code by cloning. With no remote there is nothing to clone,
    // and the session would start in a path that doesn't exist there.
    const result = dispatchAvailability({ inCheckout: true, repoKey: null, identitiesProbed: true })
    expect(result.canDispatch).toBe(false)
    expect(result.canDispatch === false && result.reason).toBe('no-remote')
  })

  test('an unprobed host is never accused of having no remote', () => {
    // WHY: the repo list is empty before it is fetched. Blocking dispatch on
    // that would disable the picker for a perfectly dispatchable project.
    expect(
      dispatchAvailability({ inCheckout: true, repoKey: null, identitiesProbed: false }).canDispatch,
    ).toBe(true)
  })

  test('a tab that is in no checkout yet can still be dispatched', () => {
    // WHY: it picks its project on the host it lands on — there is no repo to
    // fail to reach, so the constraint doesn't apply.
    expect(
      dispatchAvailability({ inCheckout: false, repoKey: null, identitiesProbed: true }).canDispatch,
    ).toBe(true)
  })

  test('a checkout with a remote dispatches', () => {
    expect(
      dispatchAvailability({
        inCheckout: true,
        repoKey: 'github.com/solus-sh/solus',
        identitiesProbed: true,
      }).canDispatch,
    ).toBe(true)
  })
})

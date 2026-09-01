import { describe, expect, test } from 'bun:test'
import {
  GUEST_RECOVERY_MAX_ATTEMPTS,
  GUEST_RECOVERY_WINDOW_MS,
  NO_GUEST_CRASHES,
  planGuestRecovery,
} from '@solus/workspace-ui/components/browser/lib/guest-recovery'
import { NativeSurfaceCoordinator } from '@solus/workspace-ui/components/browser/lib/native-surface-coordinator.svelte'

/**
 * A crashed `<webview>` cannot be reloaded in place, so recovery re-creates the
 * element. These tests hold the two edges of that: it has to happen without the
 * user asking, and it has to stop.
 */

describe('browser guest recovery', () => {
  test('the first crash is retried, and each retry waits longer', () => {
    // WHY: a guest that died once usually comes back. Retrying at a fixed
    // interval turns a page that dies on load into a hot loop instead.
    const first = planGuestRecovery(NO_GUEST_CRASHES, 1_000)
    const second = planGuestRecovery(first!.state, 1_100)
    const third = planGuestRecovery(second!.state, 1_200)

    expect(first?.delayMs).toBe(250)
    expect(second?.delayMs).toBe(500)
    expect(third?.delayMs).toBe(1_000)
  })

  test('a burst of crashes gives up rather than re-creating forever', () => {
    // WHY: this is the whole reason the budget exists. Without it, a page that
    // crashes on every load re-mounts a guest for as long as the app is open.
    let state = NO_GUEST_CRASHES
    for (let attempt = 0; attempt < GUEST_RECOVERY_MAX_ATTEMPTS; attempt += 1) {
      const plan = planGuestRecovery(state, 1_000 + attempt)
      expect(plan).not.toBeNull()
      state = plan!.state
    }

    expect(planGuestRecovery(state, 1_010)).toBeNull()
  })

  test('a crash long after the last one starts a fresh budget', () => {
    // WHY: one crash an hour is not a loop. Counting it against a burst from
    // this morning would refuse to recover a page that is basically healthy.
    let state = NO_GUEST_CRASHES
    for (let attempt = 0; attempt < GUEST_RECOVERY_MAX_ATTEMPTS; attempt += 1) {
      state = planGuestRecovery(state, 1_000)!.state
    }
    expect(planGuestRecovery(state, 1_000)).toBeNull()

    const later = planGuestRecovery(state, 1_000 + GUEST_RECOVERY_WINDOW_MS)

    expect(later?.delayMs).toBe(250)
  })
})

/**
 * The load veil covers a guest that has nothing to show. A guest is mounted
 * blank so the host can emulate it before the real page arrives, so before the
 * first load there is genuinely nothing there — but the veil has to come off and
 * stay off, or every in-page navigation would flash a blank rectangle over a
 * page that is still perfectly visible.
 */
describe('the browser load veil', () => {
  test('covers a guest until its first load finishes, then never again', () => {
    const surfaces = new NativeSurfaceCoordinator()
    const key = 'server-a:browser_veil_1'
    surfaces.mount(key)
    expect(surfaces.hasPainted(key)).toBe(false)

    surfaces.reported(key, 'ready')
    expect(surfaces.hasPainted(key)).toBe(true)

    // A later navigation reports loading again; the veil must not return, which
    // is why it is keyed on having painted rather than on the page's load state.
    surfaces.reported(key, 'loading')
    expect(surfaces.hasPainted(key)).toBe(true)
  })

  test('is owed again after a guest is replaced', () => {
    // WHY: a replacement element starts blank like any other guest, so there is
    // nothing on screen until it loads.
    const surfaces = new NativeSurfaceCoordinator()
    const key = 'server-a:browser_veil_2'
    surfaces.mount(key)
    surfaces.reported(key, 'ready')

    surfaces.reload(key)

    expect(surfaces.hasPainted(key)).toBe(false)
  })

  test('is forgotten with the page it belonged to', () => {
    const surfaces = new NativeSurfaceCoordinator()
    const key = 'server-a:browser_veil_3'
    surfaces.mount(key)
    surfaces.reported(key, 'ready')

    surfaces.retain(new Set())

    expect(surfaces.hasPainted(key)).toBe(false)
  })
})

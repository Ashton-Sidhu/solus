import { describe, expect, test } from 'bun:test'
import {
  NativeSurfaceCoordinator,
  type NativeSurfaceRect,
} from '@solus/workspace-ui/components/browser/lib/native-surface-coordinator.svelte'

/**
 * The teleport slot is published from inside the stage's `$effect`, which makes
 * how it is published a correctness question rather than a style one.
 */

const RECT: NativeSurfaceRect = { left: 10, top: 20, width: 393, height: 852, layer: 'workspace' }

describe('native surface coordinator', () => {
  test('publishing a slot never reads the published slots', () => {
    // WHY: a read here subscribes the stage's effect to the key it is about to
    // write, so every publish schedules another publish and Svelte tears the
    // renderer down with effect_update_depth_exceeded. The dedupe below has to
    // compare against something the reactive graph is not watching.
    const surfaces = new NativeSurfaceCoordinator()
    const reads: string[] = []
    const trueGet = surfaces.rects.get.bind(surfaces.rects)
    const trueHas = surfaces.rects.has.bind(surfaces.rects)
    surfaces.rects.get = (key: string) => {
      reads.push(key)
      return trueGet(key)
    }
    surfaces.rects.has = (key: string) => {
      reads.push(key)
      return trueHas(key)
    }

    const presentation = surfaces.claimPresentation('page-1')
    presentation.present(RECT)
    presentation.present({ ...RECT, top: 24 })
    presentation.release()

    expect(reads).toEqual([])
  })

  test('lifecycle commands never read the reactive phase map they publish', () => {
    // WHY: mount and presentation commands run inside Svelte effects. Reading
    // the phase map on their write path subscribes the effect to its own output
    // and recreates the update loop this coordinator is meant to remove.
    const surfaces = new NativeSurfaceCoordinator()
    const reads: string[] = []
    const trueGet = surfaces.phases.get.bind(surfaces.phases)
    const trueHas = surfaces.phases.has.bind(surfaces.phases)
    surfaces.phases.get = (key: string) => {
      reads.push(key)
      return trueGet(key)
    }
    surfaces.phases.has = (key: string) => {
      reads.push(key)
      return trueHas(key)
    }

    surfaces.mount('page-1')
    surfaces.attached('page-1')
    surfaces.reported('page-1', 'ready')
    surfaces.claimPresentation('page-1').present(RECT)

    expect(reads).toEqual([])
  })

  test('an unchanged rectangle is not republished', () => {
    // WHY: this runs on every resize frame and every pane drag. Rewriting an
    // identical rect would invalidate the webview layer's styles for nothing.
    const surfaces = new NativeSurfaceCoordinator()
    const writes: NativeSurfaceRect[] = []
    const trueSet = surfaces.rects.set.bind(surfaces.rects)
    surfaces.rects.set = (key: string, rect: NativeSurfaceRect) => {
      writes.push(rect)
      return trueSet(key, rect)
    }

    const presentation = surfaces.claimPresentation('page-1')
    presentation.present(RECT)
    presentation.present({ ...RECT })
    presentation.present({ ...RECT, width: 400 })
    presentation.present({ ...RECT, width: 400, layer: 'maximized' })

    expect(writes).toHaveLength(3)
    expect(surfaces.rects.get('page-1')?.width).toBe(400)
    expect(surfaces.rects.get('page-1')?.layer).toBe('maximized')
  })

  test('the newest claim owns the guest, and the old one is told', () => {
    // WHY: there is one guest per page and it can only be in one place. Two
    // stages overwriting each other every measurement would move the guest
    // between panes on every scroll frame instead of settling in one.
    const surfaces = new NativeSurfaceCoordinator()
    const first = surfaces.claimPresentation('page-1')
    const second = surfaces.claimPresentation('page-1')

    expect(second.present(RECT)).toBe(true)
    expect(first.present({ ...RECT, left: 999 })).toBe(false)
    expect(surfaces.rects.get('page-1')?.left).toBe(RECT.left)
  })

  test('a stage that lost the page cannot clear it on its way out', () => {
    // WHY: the losing stage still unmounts, and its release must not take the
    // guest away from the pane that now owns it.
    const surfaces = new NativeSurfaceCoordinator()
    const first = surfaces.claimPresentation('page-1')
    const second = surfaces.claimPresentation('page-1')
    second.present(RECT)

    first.release()

    expect(surfaces.rects.get('page-1')).toEqual(RECT)
  })

  test('releasing the page as its owner takes the guest off screen', () => {
    const surfaces = new NativeSurfaceCoordinator()
    const presentation = surfaces.claimPresentation('page-1')
    presentation.present(RECT)

    presentation.release()

    expect(surfaces.rects.get('page-1')).toBeUndefined()
    expect(surfaces.mountedKeys.has('page-1')).toBe(true)
  })

  test('hiding a pane parks its existing guest instead of unmounting it', () => {
    // WHY: unmounting the webview detaches its CDP surface, migrates the page to
    // a headless host, and reloads it when the pane is shown again. A temporary
    // hide must remove only the on-screen rectangle.
    const surfaces = new NativeSurfaceCoordinator()
    const presentation = surfaces.claimPresentation('page-1')
    presentation.present(RECT)

    presentation.release()

    expect(surfaces.rects.has('page-1')).toBe(false)
    expect(surfaces.mountedKeys.has('page-1')).toBe(true)
  })

  test('a page leaving the registry releases its parked guest', () => {
    // WHY: retaining guests across pane hides must not retain a closed browser
    // page for the rest of the application process.
    const surfaces = new NativeSurfaceCoordinator()
    surfaces.claimPresentation('page-1').present(RECT)
    surfaces.claimPresentation('page-2').present({ ...RECT, left: 500 })

    surfaces.retain(new Set(['page-2']))

    expect(surfaces.mountedKeys.has('page-1')).toBe(false)
    expect(surfaces.rects.has('page-1')).toBe(false)
    expect(surfaces.mountedKeys.has('page-2')).toBe(true)
  })

  test('a cleared slot starts fresh rather than being deduped away', () => {
    // WHY: the pane clears on hide and republishes the same rect on show. If the
    // dedupe outlived the clear, the guest would stay parked offscreen.
    const surfaces = new NativeSurfaceCoordinator()
    const presentation = surfaces.claimPresentation('page-1')

    presentation.present(RECT)
    presentation.park()
    presentation.present(RECT)

    expect(surfaces.rects.get('page-1')).toEqual(RECT)
  })

  test('mount, load, park, present, and close are one explicit lifecycle', () => {
    // WHY: visibility, ownership, and lifetime used to live in separate stores.
    // One transition could therefore unmount a guest or expose it before paint.
    const surfaces = new NativeSurfaceCoordinator()

    surfaces.mount('page-1')
    expect(surfaces.phaseOf('page-1')).toBe('mounting')
    expect(surfaces.rects.has('page-1')).toBe(false)

    surfaces.attached('page-1')
    expect(surfaces.phaseOf('page-1')).toBe('loading')
    surfaces.reported('page-1', 'ready')
    expect(surfaces.phaseOf('page-1')).toBe('ready')

    const presentation = surfaces.claimPresentation('page-1')
    presentation.present(RECT)
    expect(surfaces.phaseOf('page-1')).toBe('presented')
    presentation.release()
    expect(surfaces.phaseOf('page-1')).toBe('parked')

    surfaces.close('page-1')
    expect(surfaces.phaseOf('page-1')).toBe('absent')
    expect(surfaces.mountedKeys.has('page-1')).toBe(false)
  })
})

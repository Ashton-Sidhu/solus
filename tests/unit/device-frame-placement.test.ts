import { describe, expect, test } from 'bun:test'
import { DEVICE_ORIENTATIONS, type DeviceScreenConfig } from '@solus/contracts/device-types'
import { iosRawPoint } from '@solus/client-core/device-protocol'
import { framePlacement } from '@solus/workspace-ui/components/devices/lib/device-video'

/**
 * serve-sim streams an iPad's portrait framebuffer after it rotates and only
 * reports the new orientation. The client must turn the frame so the user sees
 * landscape, and the turn must be the exact inverse of the host's tap mapping,
 * or a tap lands on a different control than the one drawn under it.
 */

const RAW = { width: 2064, height: 2752 }

function drawn(transform: number[], x: number, y: number) {
  const [a, b, c, d, e, f] = transform as [number, number, number, number, number, number]
  return { x: a * x + c * y + e, y: b * x + d * y + f }
}

describe('framePlacement', () => {
  test('a landscape iPad is drawn landscape', () => {
    for (const orientation of ['landscape_left', 'landscape_right'] as const) {
      const placement = framePlacement({ ...RAW, orientation }, RAW.width, RAW.height)
      expect(placement).toMatchObject({ width: RAW.height, height: RAW.width })
    }
  })

  test('every drawn point maps back to its raw point through the host', () => {
    for (const orientation of DEVICE_ORIENTATIONS) {
      const screen: DeviceScreenConfig = { ...RAW, orientation }
      const placement = framePlacement(screen, RAW.width, RAW.height)
      const raw = { x: 0.2, y: 0.7 }
      const point = drawn(placement.transform, raw.x * RAW.width, raw.y * RAW.height)
      const tap = iosRawPoint(screen, point.x / placement.width, point.y / placement.height)
      expect(tap.x).toBeCloseTo(raw.x)
      expect(tap.y).toBeCloseTo(raw.y)
    }
  })

  test('a frame that is already landscape-shaped, or has no screen, is drawn as received', () => {
    const wide = framePlacement({ width: 2752, height: 2064, orientation: 'landscape_left' }, 2752, 2064)
    expect(wide).toEqual({ width: 2752, height: 2064, transform: [1, 0, 0, 1, 0, 0] })
    expect(framePlacement(null, 1080, 2400).transform).toEqual([1, 0, 0, 1, 0, 0])
  })
})

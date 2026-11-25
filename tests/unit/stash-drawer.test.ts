import { describe, expect, test } from 'bun:test'
import { stashDrawerVerticalPosition } from '../../packages/workspace-ui/src/components/input/lib/stash-drawer'

describe('stash drawer position', () => {
  test('attaches to the composer when there is space above it', () => {
    expect(stashDrawerVerticalPosition(520, 0, 720)).toEqual({ bottom: 520, maxHeight: 508 })
  })

  test('keeps the header and an entry visible when a tall composer reaches the top edge', () => {
    expect(stashDrawerVerticalPosition(40, 0, 360)).toEqual({ bottom: 108, maxHeight: 96 })
  })

  test('fits within the visible viewport when it is offset and very short', () => {
    expect(stashDrawerVerticalPosition(420, 160, 80)).toEqual({ bottom: 228, maxHeight: 56 })
  })
})

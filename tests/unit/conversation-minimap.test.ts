import { describe, expect, test } from 'bun:test'
import { pickActiveIndex } from '@solus/workspace-ui/components/conversation/lib/minimap'

describe('conversation minimap active marker', () => {
  test('moves through mounted rows after an unmounted transcript prefix', () => {
    // WHY: the transcript keeps all prompts in the rail but mounts only its
    // tail. Missing prefix nodes are above the viewport, not below the active
    // line; treating them as below leaves the first marker active forever.
    const tops: Array<number | null> = [null, null, -40, 60, 180]
    expect(pickActiveIndex(tops.length, (index) => tops[index], 2)).toBe(3)
  })

  test('stops before missing rows after the mounted window', () => {
    const tops: Array<number | null> = [null, -40, 180, null]
    expect(pickActiveIndex(tops.length, (index) => tops[index], 1)).toBe(1)
  })
})

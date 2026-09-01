import { describe, expect, test } from 'bun:test'
import { guardDeferredCompositionClear } from '@solus/workspace-ui/components/ui/plain-text-editor/lib/deferred-clear'

describe('deferred mobile composition clear', () => {
  test('clears the sent value again when iOS restores it after several frames', () => {
    // WHY: iOS can settle a keyboard composition later than the old two-frame
    // retry. Every prompt-send path uses this editor clear.
    let value = 'send this'
    let now = 0
    const frames: FrameRequestCallback[] = []

    guardDeferredCompositionClear({
      readValue: () => value,
      clear: () => (value = ''),
      requestFrame: (callback) => frames.push(callback),
      now: () => now,
    })

    expect(value).toBe('')
    for (let frame = 0; frame < 4; frame++) {
      now += 16
      frames.shift()?.(now)
    }
    value = 'send this'
    now += 16
    frames.shift()?.(now)

    expect(value).toBe('')
  })

  test('does not remove different text typed after sending', () => {
    let value = 'first prompt'
    let now = 0
    const frames: FrameRequestCallback[] = []

    guardDeferredCompositionClear({
      readValue: () => value,
      clear: () => (value = ''),
      requestFrame: (callback) => frames.push(callback),
      now: () => now,
    })

    value = 'next prompt'
    now += 16
    frames.shift()?.(now)

    expect(value).toBe('next prompt')
  })

  test('stops checking after the composition settlement window', () => {
    let value = 'sent'
    let now = 0
    const frames: FrameRequestCallback[] = []

    guardDeferredCompositionClear({
      readValue: () => value,
      clear: () => (value = ''),
      requestFrame: (callback) => frames.push(callback),
      now: () => now,
      durationMs: 30,
    })

    now = 16
    frames.shift()?.(now)
    now = 32
    frames.shift()?.(now)
    value = 'sent'

    expect(frames).toHaveLength(0)
    expect(value).toBe('sent')
  })
})

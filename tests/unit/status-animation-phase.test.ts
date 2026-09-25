import { describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { alignStatusAnimationPhase } from '@solus/workspace-ui/components/session/lib/status-animation-phase'

// Two running rows mount a second apart. Each glyph's CSS animation starts on
// its own mount, so without alignment their spinners and pulses turn out of
// phase. Pinning every one to the same document-timeline origin makes them
// turn together.

function glyph(animations: Array<{ animationName?: string; startTime: number }>) {
  const element = new JSDOM('<span></span>').window.document.querySelector('span')!
  // SAFETY: the helper reads only animationName and startTime from each animation.
  element.getAnimations = () => animations as unknown as Animation[]
  return element
}

describe('alignStatusAnimationPhase', () => {
  test('pins every instance of the started animation to one phase', () => {
    const early = { animationName: 'spin', startTime: 120 }
    const late = { animationName: 'spin', startTime: 1_340 }

    alignStatusAnimationPhase({ animationName: 'spin', target: glyph([early]) })
    alignStatusAnimationPhase({ animationName: 'spin', target: glyph([late]) })

    expect(early.startTime).toBe(late.startTime)
    expect(early.startTime).toBe(0)
  })

  test('leaves other animations on the element alone', () => {
    const pulse = { animationName: 'pulse', startTime: 975 }
    const fade = { animationName: 'fade-in', startTime: 125 }
    const scripted = { startTime: 250 }

    alignStatusAnimationPhase({ animationName: 'pulse', target: glyph([pulse, fade, scripted]) })

    expect([pulse.startTime, fade.startTime, scripted.startTime]).toEqual([0, 125, 250])
  })

  test('does nothing where the Web Animations API is missing', () => {
    const element = new JSDOM('<span></span>').window.document.querySelector('span')!
    expect('getAnimations' in element).toBe(false)

    expect(() => alignStatusAnimationPhase({ animationName: 'spin', target: element })).not.toThrow()
    expect(() => alignStatusAnimationPhase({ animationName: 'spin', target: null })).not.toThrow()
  })
})

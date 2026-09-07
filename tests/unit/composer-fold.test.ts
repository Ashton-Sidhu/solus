import { describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import {
  COMPOSER_FOLD_DURATION_MS,
  COMPOSER_FOLD_EASING,
  composerSurfaceOf,
  foldTweenBounds,
  measureFold,
  promptSlideOffset,
  toolbarArrival,
  tweenComposerFold,
} from '@solus/workspace-ui/components/input/lib/composer-fold'

describe('whether the fold tweens the card at all', () => {
  test('a card that changed height tweens between the two heights', () => {
    expect(foldTweenBounds({ previousHeight: 104, nextHeight: 56, reducedMotion: false })).toEqual({
      from: 104,
      to: 56,
    })
  })

  test('the first paint, a hidden tab, and a fold that moved nothing are cuts', () => {
    // WHY: with no previous height there is nothing to tween from, and a
    // hidden tab reports every box as zero. Pinning a zero-height host there
    // would hold the dock shut when the tab is shown.
    expect(foldTweenBounds({ previousHeight: null, nextHeight: 56, reducedMotion: false })).toBeNull()
    expect(foldTweenBounds({ previousHeight: 0, nextHeight: 0, reducedMotion: false })).toBeNull()
    expect(foldTweenBounds({ previousHeight: 56, nextHeight: 56.2, reducedMotion: false })).toBeNull()
  })

  test('reduced motion turns the tween into a cut', () => {
    expect(foldTweenBounds({ previousHeight: 104, nextHeight: 56, reducedMotion: true })).toBeNull()
  })
})

describe('what moves inside the card', () => {
  test('the prompt line starts from where it was', () => {
    // WHY: the well's padding and the card's top edge both change in one
    // step. Without the slide the text jumps at the start of the fold and the
    // card catches up under it.
    expect(promptSlideOffset(120, 160)).toBe(-40)
    expect(promptSlideOffset(160, 160.2)).toBeNull()
    expect(promptSlideOffset(null, 160)).toBeNull()
  })

  test('the toolbar arrives through the second half of an unfold, and just leaves on a fold', () => {
    // WHY: on expand the row returns to the space the prompt line still
    // occupies while the card is short. Fading it in early paints the pickers
    // through the text.
    expect(toolbarArrival(false, 280)).toEqual({ duration: 140, delay: 140 })
    expect(toolbarArrival(true, 280)).toBeNull()
  })
})

describe('the card during the tween', () => {
  function mountCard() {
    const dom = new JSDOM(`
      <div id="dock"><div id="host"><div id="header"></div><div id="card" data-composer-surface>
        <div id="bar">
          <div id="well" data-composer-prompt><div class="cm-content" id="line"></div></div>
          <div id="toolbar" data-composer-toolbar></div>
        </div>
      </div></div></div>
    `)
    const { window } = dom
    const doc = window.document
    const host = doc.getElementById('host') as HTMLElement
    const card = doc.getElementById('card') as HTMLElement
    const bar = doc.getElementById('bar') as HTMLElement
    const well = doc.getElementById('well') as HTMLElement
    const line = doc.getElementById('line') as HTMLElement
    const toolbar = doc.getElementById('toolbar') as HTMLElement
    // jsdom lays nothing out and has no animations, so the geometry and the
    // animations are stood in for.
    let cardHeight = 56
    let lineTop = 600
    card.getBoundingClientRect = () => ({ height: cardHeight }) as DOMRect
    host.getBoundingClientRect = () => ({ height: cardHeight + 24 }) as DOMRect
    line.getBoundingClientRect = () => ({ top: lineTop }) as DOMRect
    const animations: Array<{
      target: string
      cancelled: number
      keyframes: Keyframe[]
      options: KeyframeAnimationOptions
      finish: () => void
    }> = []
    for (const el of [card, well, toolbar]) {
      el.animate = ((keyframes: Keyframe[], options: KeyframeAnimationOptions) => {
        let finish: () => void = () => {}
        const finished = new Promise<void>((resolve) => {
          finish = resolve
        })
        const animation = {
          target: el.id,
          cancelled: 0,
          keyframes,
          options,
          finish,
          cancel() {
            this.cancelled += 1
          },
          finished,
        }
        animations.push(animation)
        return animation as unknown as Animation
      }) as typeof el.animate
    }
    Object.defineProperty(globalThis, 'window', { value: window, configurable: true })
    Object.defineProperty(globalThis, 'getComputedStyle', {
      value: () => ({ position: 'static' }),
      configurable: true,
    })
    return {
      host,
      card,
      bar,
      animations,
      setGeometry: (height: number, top: number) => {
        cardHeight = height
        lineTop = top
      },
    }
  }

  test('the bar finds its card through the surface mark, and reads the line inside the well', () => {
    const { card, bar } = mountCard()
    expect(composerSurfaceOf(bar)).toBe(card)
    expect(measureFold(card)).toEqual({ height: 56, promptTop: 600 })
  })

  test('the host holds its height and the card leaves flow, then both return', async () => {
    // WHY: this is the whole point. While the card's height tweens, the
    // column above must not lay out — the host keeps the destination height
    // and the card is anchored to its bottom edge. When the tween ends every
    // inline style goes, so a card that grows later lays out naturally.
    const { host, card, animations } = mountCard()
    const tween = tweenComposerFold(card, { height: 104, promptTop: 560 }, true)
    expect(tween).not.toBeNull()
    expect(host.style.height).toBe('80px')
    expect(host.style.position).toBe('relative')
    expect(card.style.position).toBe('absolute')
    expect(card.style.bottom).toBe('0px')
    expect(card.style.overflow).toBe('clip')
    expect(animations[0]!.target).toBe('card')
    expect(animations[0]!.keyframes).toEqual([{ height: '104px' }, { height: '56px' }])
    expect(animations[0]!.options).toEqual({
      duration: COMPOSER_FOLD_DURATION_MS,
      easing: COMPOSER_FOLD_EASING,
    })

    animations[0]!.finish()
    await Promise.resolve()
    expect(host.style.height).toBe('')
    expect(host.style.position).toBe('')
    expect(card.style.position).toBe('')
    expect(card.style.overflow).toBe('')
    expect(animations.every((animation) => animation.cancelled === 1)).toBe(true)
  })

  test('a fold slides the prompt line and lets the toolbar leave', () => {
    const { card, animations } = mountCard()
    tweenComposerFold(card, { height: 104, promptTop: 560 }, true)
    expect(animations.map((animation) => animation.target)).toEqual(['card', 'well'])
    expect(animations[1]!.keyframes).toEqual([{ transform: 'translateY(-40px)' }, { transform: 'none' }])
  })

  test('an unfold slides the prompt line and brings the toolbar in late', () => {
    const { card, animations } = mountCard()
    tweenComposerFold(card, { height: 40, promptTop: 620 }, false)
    expect(animations.map((animation) => animation.target)).toEqual(['card', 'well', 'toolbar'])
    expect(animations[1]!.keyframes).toEqual([{ transform: 'translateY(20px)' }, { transform: 'none' }])
    expect(animations[2]!.options).toMatchObject({
      delay: COMPOSER_FOLD_DURATION_MS / 2,
      duration: COMPOSER_FOLD_DURATION_MS / 2,
      fill: 'backwards',
    })
  })

  test('cancelling mid-tween returns the layout at once, only once', async () => {
    // WHY: a fold interrupted by the next fold must hand back a natural
    // layout to measure from. A finish arriving after the cancel must not
    // strip styles a newer tween has since set.
    const { host, card, animations, setGeometry } = mountCard()
    const first = tweenComposerFold(card, { height: 104, promptTop: 560 }, true)!
    first.cancel()
    expect(host.style.height).toBe('')
    expect(animations[0]!.cancelled).toBe(1)

    setGeometry(104, 560)
    tweenComposerFold(card, { height: 70, promptTop: 590 }, false)
    expect(host.style.height).toBe('128px')
    animations[0]!.finish()
    await Promise.resolve()
    expect(host.style.height).toBe('128px')
    expect(animations[0]!.cancelled).toBe(1)
  })

  test('nothing is pinned when there is nothing to tween', () => {
    const { host, card } = mountCard()
    expect(tweenComposerFold(card, null, true)).toBeNull()
    expect(host.style.height).toBe('')
    expect(card.style.position).toBe('')
  })
})

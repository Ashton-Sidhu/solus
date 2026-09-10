/**
 * The fold and expand animation.
 *
 * The fold flips the layout in one step (ADR-0027): the toolbar row folds to
 * nothing, the text well tightens, and the card takes its new height. Nothing
 * inside the card transitions in CSS. The conversation is out of reach either
 * way — the dock floats over it and reserves a band that a fold does not
 * change (`resolveComposerInset`) — but a card tweened in flow would still
 * relayout its own host on every frame.
 *
 * So the motion is a FLIP on the flipped layout, run through the Web
 * Animations API. For the length of the tween the card's host holds its
 * destination height and the card is lifted out of flow, anchored to the
 * host's bottom edge, with its height tweened from where it was. The prompt
 * line slides from its old position to its new one so the text settles rather
 * than jumps, and on expand the toolbar row arrives through the second half
 * of the tween with a fade and a short drift, once the card has grown room
 * for it. The host moves once per fold; the card catches up over the tween.
 * Every inline style is removed when the tween ends, so anything that resizes
 * the card afterwards lays out naturally.
 *
 * A host opts in by marking the card `data-composer-surface`. The card must
 * clip its own overflow; the host's own height is read from layout, so a
 * header above the card stays where it is.
 */

export const COMPOSER_FOLD_DURATION_MS = 280
export const COMPOSER_FOLD_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)'
/** How far the arriving toolbar travels as it fades in. */
const TOOLBAR_ARRIVAL_DRIFT_PX = 4
/** Room past the clock for a document timeline that never reports finished. */
const CLEANUP_BUFFER_MS = 50

export const COMPOSER_SURFACE_ATTRIBUTE = 'data-composer-surface'
/** The text well. Its prompt line is what slides through the fold. */
export const COMPOSER_PROMPT_ATTRIBUTE = 'data-composer-prompt'
/** The toolbar row that folds away and arrives again. */
export const COMPOSER_TOOLBAR_ATTRIBUTE = 'data-composer-toolbar'
export const COMPOSER_ACTIONS_ATTRIBUTE = 'data-composer-actions'
/**
 * Whether the card stands folded. Published on the surface for the dock that
 * reserves room for it: a folded measurement may hold that reservation, never
 * shrink it (`resolveComposerInset`).
 */
export const COMPOSER_COLLAPSED_ATTRIBUTE = 'data-composer-collapsed'

export function composerSurfaceOf(node: Element): HTMLElement | null {
  // The mark is only ever placed on an element with a style, so the typed
  // lookup is honest; an `instanceof` would fail in another realm anyway.
  return node.closest<HTMLElement>(`[${COMPOSER_SURFACE_ATTRIBUTE}]`)
}

export interface FoldGeometry {
  /** The card's height. */
  height: number
  /** Where the prompt line stands in the viewport, when the well is on screen. */
  promptTop: number | null
  actionsTop?: number | null
  toolbar?: { top: number; height: number; opacity: number } | null
}

/**
 * The card as it stands now — mid-tween, if one is running, since animated
 * heights and transforms are what the rects report. The prompt line is read
 * from the editor's content box rather than the well, so a change of well
 * padding is part of the slide instead of a jump inside it.
 */
export function measureFold(surface: HTMLElement): FoldGeometry {
  const well = surface.querySelector<HTMLElement>(`[${COMPOSER_PROMPT_ATTRIBUTE}]`)
  const line = well?.querySelector<HTMLElement>('.cm-content') ?? well
  const actions = surface.querySelector<HTMLElement>(`[${COMPOSER_ACTIONS_ATTRIBUTE}]`)
  const toolbar = surface.querySelector<HTMLElement>(`[${COMPOSER_TOOLBAR_ATTRIBUTE}]`)
  const toolbarRect = toolbar?.getBoundingClientRect()
  return {
    height: surface.getBoundingClientRect().height,
    promptTop: line ? line.getBoundingClientRect().top : null,
    actionsTop: actions?.getBoundingClientRect().top ?? null,
    toolbar: toolbar && toolbarRect && toolbarRect.height > 0
      ? { top: toolbarRect.top, height: toolbarRect.height, opacity: Number(getComputedStyle(toolbar).opacity) }
      : null,
  }
}

export interface FoldTweenBounds {
  from: number
  to: number
}

/**
 * Whether there is anything to tween, and between which heights. Nothing to
 * do when the card has no previous height (first paint, or a hidden tab whose
 * boxes are all zero), when the fold did not change the height, or when the
 * user asked for reduced motion — the fold is a cut then.
 */
export function foldTweenBounds(args: {
  previousHeight: number | null
  nextHeight: number
  reducedMotion: boolean
}): FoldTweenBounds | null {
  if (args.reducedMotion || args.previousHeight === null) return null
  if (Math.abs(args.previousHeight - args.nextHeight) < 0.5) return null
  return { from: args.previousHeight, to: args.nextHeight }
}

/** How far the prompt line must start from to appear not to have moved. */
export function promptSlideOffset(previousTop: number | null, nextTop: number | null): number | null {
  if (previousTop === null || nextTop === null) return null
  const offset = previousTop - nextTop
  return Math.abs(offset) < 0.5 ? null : offset
}

/**
 * When the toolbar row fades in. Collapse has its own departure animation;
 * an unfolding row returns to the space the prompt line still occupies
 * while the card is short, so it waits out the first half of the tween and
 * arrives once the geometry has mostly settled.
 */
export function toolbarArrival(
  collapsed: boolean,
  duration: number,
): { duration: number; delay: number } | null {
  if (collapsed) return null
  return { duration: duration / 2, delay: duration / 2 }
}

export interface ComposerFoldTween {
  /** End the tween now and return the card and its host to natural layout. */
  cancel(): void
}

export function tweenComposerFold(
  surface: HTMLElement,
  previous: FoldGeometry | null,
  collapsed: boolean,
): ComposerFoldTween | null {
  const host = surface.parentElement
  if (!host) return null
  const next = measureFold(surface)
  const bounds = foldTweenBounds({
    previousHeight: previous?.height ?? null,
    nextHeight: next.height,
    reducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  })
  if (!bounds) return null

  const duration = COMPOSER_FOLD_DURATION_MS
  const easing = COMPOSER_FOLD_EASING
  const hostHeight = host.getBoundingClientRect().height
  const hostWasStatic = getComputedStyle(host).position === 'static'

  host.style.height = `${hostHeight}px`
  if (hostWasStatic) host.style.position = 'relative'
  surface.style.position = 'absolute'
  surface.style.left = '0'
  surface.style.right = '0'
  surface.style.bottom = '0'
  surface.style.overflow = 'clip'

  const animations: Animation[] = [
    surface.animate([{ height: `${bounds.from}px` }, { height: `${bounds.to}px` }], {
      duration,
      easing,
    }),
  ]

  // The card now stands at its previous height, so the prompt line's next
  // position is read against that box; the slide closes the gap to where it
  // was a moment ago.
  const well = surface.querySelector<HTMLElement>(`[${COMPOSER_PROMPT_ATTRIBUTE}]`)
  const slide = promptSlideOffset(previous?.promptTop ?? null, measureFold(surface).promptTop)
  if (well && slide !== null) {
    animations.push(
      well.animate([{ transform: `translateY(${slide}px)` }, { transform: 'none' }], {
        duration,
        easing,
      }),
    )
  }

  const toolbar = surface.querySelector<HTMLElement>(`[${COMPOSER_TOOLBAR_ATTRIBUTE}]`)
  const arrival = toolbarArrival(collapsed, duration)
  if (toolbar && arrival) {
    animations.push(
      toolbar.animate(
        [
          { opacity: 0, transform: `translateY(${TOOLBAR_ARRIVAL_DRIFT_PX}px)` },
          { opacity: 1, transform: 'none' },
        ],
        { ...arrival, fill: 'backwards', easing },
      ),
    )
  }

  const restoreToolbar = collapsed
    ? animateCollapseContents(surface, previous, animations)
    : null

  let settled = false
  const settle = () => {
    if (settled) return
    settled = true
    clearTimeout(fallback)
    for (const animation of animations) animation.cancel()
    restoreToolbar?.()
    host.style.removeProperty('height')
    if (hostWasStatic) host.style.removeProperty('position')
    surface.style.removeProperty('position')
    surface.style.removeProperty('left')
    surface.style.removeProperty('right')
    surface.style.removeProperty('bottom')
    surface.style.removeProperty('overflow')
  }
  const fallback = setTimeout(settle, duration + CLEANUP_BUFFER_MS)
  animations[0]!.finished.then(settle, () => undefined)
  return { cancel: settle }
}

/** Animate controls after collapse has changed their containing block. */
function animateCollapseContents(
  surface: HTMLElement,
  previous: FoldGeometry | null,
  animations: Animation[],
): (() => void) | null {
  const duration = COMPOSER_FOLD_DURATION_MS
  const easing = COMPOSER_FOLD_EASING
  // The buttons are positioned against the inner content, which has already
  // collapsed. Compensate for that jump while the outer card catches up.
  const actions = surface.querySelector<HTMLElement>(`[${COMPOSER_ACTIONS_ATTRIBUTE}]`)
  if (actions) {
    const offset = promptSlideOffset(previous?.actionsTop ?? null, actions.getBoundingClientRect().top)
    if (offset !== null) {
      animations.push(actions.animate(
        [{ transform: `translateY(${offset}px)` }, { transform: 'none' }],
        { duration, easing },
      ))
    }
  }

  const toolbar = surface.querySelector<HTMLElement>(`[${COMPOSER_TOOLBAR_ATTRIBUTE}]`)
  // Keep the departing row at its old height, outside layout, while it fades.
  // It is already inert, so visible controls cannot take focus during the exit.
  const toolbarStyle = toolbar?.getAttribute('style') ?? null
  const geometry = previous?.toolbar
  if (!toolbar || !geometry) return null
  Object.assign(toolbar.style, {
    position: 'absolute', left: '0', right: '0', bottom: '0',
    height: `${geometry.height}px`, visibility: 'visible',
    gridTemplateRows: '1fr',
  })
  const offset = geometry.top - toolbar.getBoundingClientRect().top
  animations.push(toolbar.animate(
    [{ transform: `translateY(${offset}px)` }, { transform: 'none' }],
    { duration, easing },
  ))
  animations.push(toolbar.animate(
    [{ opacity: geometry.opacity }, { opacity: 0 }],
    { duration: duration / 2, easing, fill: 'forwards' },
  ))

  return () => {
    if (toolbarStyle === null) toolbar.removeAttribute('style')
    else toolbar.setAttribute('style', toolbarStyle)
  }
}

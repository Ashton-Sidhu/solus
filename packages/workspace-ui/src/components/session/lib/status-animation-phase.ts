// Adapted from T3 Code's synchronizeTerminalPulse (apps/web/src/components/ThreadStatusIndicators.tsx,
// MIT License, Copyright (c) 2026 T3 Tools Inc.).

type AnimationPhaseEvent = Pick<AnimationEvent, 'animationName' | 'target'>

function hasAnimations(target: EventTarget): target is EventTarget & Pick<Element, 'getAnimations'> {
  return 'getAnimations' in target
}

/**
 * Pin a status glyph's CSS animation to the start of the document timeline, so
 * every spinner or pulse of the same kind turns in one phase however late its
 * row mounted. Bind it as `onanimationstart` on the glyph or any ancestor;
 * `animationstart` bubbles, and the event names the element that animates.
 *
 * It runs once per animation start: no timer, no frame loop, no state. A
 * reduced-motion glyph has no animation, so it never fires. Where the host has
 * no Web Animations API, the glyph keeps its own phase.
 */
export function alignStatusAnimationPhase(event: AnimationPhaseEvent): void {
  const target = event.target
  if (!target || !hasAnimations(target)) return

  for (const animation of target.getAnimations()) {
    if ('animationName' in animation && animation.animationName === event.animationName) {
      animation.startTime = 0
    }
  }
}

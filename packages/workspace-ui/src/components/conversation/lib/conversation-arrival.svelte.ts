import { tick } from 'svelte'
import type { ConversationViewState } from './conversation-view-state.svelte'
import { settleScroll, type createEndFollow } from './response-scroll'

interface ConversationArrivalOptions {
  viewState: ConversationViewState
  scroll: () => HTMLElement | null
  follower: () => ReturnType<typeof createEndFollow> | undefined
  openingSearch: () => boolean
  onSettled: () => void
}

/** Owns the visible view's arrival, not the session's history request. */
export class ConversationArrival {
  pending = $state(true)
  isAwayFromEnd = $state(false)
  jumpingToEnd = false

  constructor(private readonly options: ConversationArrivalOptions) {}

  /** The caller starts only when history is usable and cancels on hide or unmount. */
  open(): () => void {
    let cancelled = false
    this.pending = true
    const { viewState, follower } = this.options
    const position = viewState.position
    if (position) follower()?.release()
    void tick().then(() => requestAnimationFrame(async () => {
      if (cancelled) return
      const element = this.options.scroll()
      if (!element) return
      const { virtualizer } = viewState
      let target: (() => number | undefined) | undefined
      if (this.options.openingSearch()) {
        // Search owns the initial reading position.
      } else if (position && await virtualizer.restore(position, () => cancelled)) {
        target = () => {
          const top = virtualizer.top(position.key)
          return top === undefined ? undefined : top + position.offset
        }
      } else if (!cancelled) {
        viewState.position = null
        follower()?.jump()
        target = () => element.scrollHeight - element.clientHeight
      }
      if (cancelled) return
      if (target) await settleScroll(element, target, () => cancelled)
      if (cancelled) return
      this.isAwayFromEnd = !(follower()?.atEnd ?? true)
      this.pending = false
      this.options.onSettled()
    }))
    return () => {
      cancelled = true
      this.pending = true
    }
  }

  /** Glide only the last screen, then let measured rows establish the end. */
  async jumpToEnd(isVisible: () => boolean): Promise<void> {
    const element = this.options.scroll()
    if (!element) return
    this.isAwayFromEnd = false
    this.jumpingToEnd = true
    const readerInput = new AbortController()
    let readerMoved = false
    for (const event of ['wheel', 'touchstart', 'keydown']) {
      element.addEventListener(event, () => { readerMoved = true }, { passive: true, signal: readerInput.signal })
    }
    const end = () => element.scrollHeight - element.clientHeight
    try {
      if (end() - element.scrollTop > element.clientHeight) {
        element.scrollTop = end() - element.clientHeight
        await new Promise(requestAnimationFrame)
      }
      if (readerMoved || !isVisible()) return
      this.options.follower()?.jump(true)
      if (this.options.follower()?.moving) {
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer)
            element.removeEventListener('scrollend', done)
            resolve()
          }
          const timer = setTimeout(done, 600)
          element.addEventListener('scrollend', done)
        })
      }
      await settleScroll(element, end, () => readerMoved || !isVisible())
    } finally {
      readerInput.abort()
      this.jumpingToEnd = false
    }
  }
}

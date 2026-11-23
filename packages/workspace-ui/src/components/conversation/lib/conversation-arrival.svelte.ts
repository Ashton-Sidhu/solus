import { tick } from 'svelte'
import type { ConversationViewState } from './conversation-view-state.svelte'
import { settleScroll, type createEndFollow } from './response-scroll'
import { waitForFrameHeightsIn } from '../../artifact/lib/artifact-view'

interface ConversationArrivalOptions {
  viewState: ConversationViewState
  scroll: () => HTMLElement | null
  follower: () => ReturnType<typeof createEndFollow> | undefined
  openingSearch: () => boolean
  /** A read still on its way whose answer adds rows, such as the turn
   *  snapshots that draw each turn's changes card. */
  pendingRowData: () => Promise<unknown> | undefined
  hasOlderHistory: () => boolean
  loadOlderHistory: () => Promise<void>
  onSettled: () => void
}

/** The longest the rows stay hidden for row data. A slow host must not hold
 *  the conversation: its rows then show, and the data moves them when it lands. */
const ROW_DATA_WAIT_MS = 300

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
      // A card that mounts after the rows show grows its turn and pushes the
      // reader away from the place settled below. Let the data land first.
      const rowData = this.options.pendingRowData()
      if (rowData) {
        await Promise.race([rowData.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, ROW_DATA_WAIT_MS))])
        await tick()
        if (cancelled) return
      }
      // A first page shorter than the view reads older pages now, while the
      // rows are hidden. Read after they show, each page lands above the
      // reader and the view snaps down to the end.
      while (element.clientHeight > 0 && element.scrollHeight <= element.clientHeight && this.options.hasOlderHistory()) {
        const height = element.scrollHeight
        const loaded = await this.options.loadOlderHistory().then(() => true, () => false)
        await tick()
        if (cancelled) return
        if (!loaded || element.scrollHeight <= height) break
      }
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
      // An HTML frame in view with no height yet grows when it reports one and
      // moves the rows. Show them once it has, then settle on the place again.
      if (target && await waitForFrameHeightsIn(element, () => cancelled)) await settleScroll(element, target, () => cancelled)
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

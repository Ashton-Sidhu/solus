import { tick } from 'svelte'
import { TranscriptGeometry, type TranscriptRange } from './transcript-geometry'

/** What the reader is looking at: the element at the viewport top, and where
 *  it sat in the scroll content when last measured. */
interface ScrollAnchor { element: Element; top: number }

/**
 * Mounts the transcript rows near the viewport and keeps what the reader is
 * looking at still while the rows around it change height.
 *
 * Two jobs, kept apart. The geometry — measured row heights, estimates for
 * rows never mounted — only decides which rows to mount. Holding the view
 * still is done from the DOM alone, the way native scroll anchoring works: an
 * anchor element at the viewport top is measured again after every layout
 * change the virtualizer can see, and the scroll moves by exactly how far the
 * anchor moved. Estimates never reach the scroll position, and no correction
 * waits for a later tick, so a render that loads and grows above the reader,
 * a row that mounts taller than its estimate, and a page of older history all
 * land in the same frame without a visible jump.
 */
export class TranscriptVirtualizer {
  range = $state<TranscriptRange>({ start: 0, end: 0, before: 0, after: 0 })
  revision = $state(0)
  pinnedKeys = $state<string[]>([])
  readonly geometry = new TranscriptGeometry()
  private scroll: HTMLElement | null = null
  private content: HTMLElement | null = null
  private observer: ResizeObserver | null = null
  private nodes = new Map<HTMLElement, string>()
  private frame = 0
  private origin = 0
  private anchor: ScrollAnchor | null = null
  /** How far the anchor's row moved in the geometry when keys changed, until
   *  the new rows render and the DOM anchor takes over. Without it the range
   *  would be chosen at the old position and unmount the anchor's own row. */
  private pendingShift = 0

  connect(scroll: HTMLElement, content: HTMLElement): () => void {
    this.scroll = scroll
    this.content = content
    this.observer = new ResizeObserver((entries) => {
      let changed = false
      for (const entry of entries) {
        if (!(entry.target instanceof HTMLElement)) continue
        const key = this.nodes.get(entry.target)
        if (key) changed = this.geometry.measure(key, entry.borderBoxSize[0]?.blockSize ?? entry.target.offsetHeight) || changed
      }
      if (changed) {
        this.geometry.rebuild()
        this.revision++
      }
      this.holdAnchor()
      this.refresh()
    })
    for (const node of this.nodes.keys()) this.observer.observe(node)
    this.observer.observe(scroll)
    scroll.addEventListener('scroll', this.schedule, { passive: true })
    document.addEventListener('selectionchange', this.schedule)
    content.addEventListener('focusout', this.schedule)
    this.refresh()
    return () => {
      scroll.removeEventListener('scroll', this.schedule)
      document.removeEventListener('selectionchange', this.schedule)
      content.removeEventListener('focusout', this.schedule)
      this.observer?.disconnect()
      this.observer = null
      cancelAnimationFrame(this.frame)
      this.frame = 0
      this.scroll = null
      this.content = null
      this.anchor = null
      this.pendingShift = 0
    }
  }

  setKeys(keys: string[]): void {
    if (keys.length === this.geometry.keys.length && keys.every((key, index) => key === this.geometry.keys[index])) return
    const anchorKey = this.anchorKey()
    const before = anchorKey === undefined ? undefined : this.geometry.top(anchorKey)
    this.geometry.setKeys(keys)
    const after = anchorKey === undefined ? undefined : this.geometry.top(anchorKey)
    if (before !== undefined && after !== undefined) this.pendingShift += after - before
    this.revision++
    this.refresh()
  }

  /** The list rendered new slots: mounted or unmounted rows and resized
   *  spacers may have moved the anchor. The mounted rows are measured here
   *  rather than waiting for the ResizeObserver: a row unmounts into a spacer
   *  of its recorded height, and a stale record moved everything below it —
   *  which moved the anchor, which moved the range, which mounted the row
   *  again, in a loop. */
  rendered(): void {
    this.pendingShift = 0
    let changed = false
    for (const [node, key] of this.nodes) changed = this.geometry.measure(key, node.getBoundingClientRect().height) || changed
    if (changed) {
      this.geometry.rebuild()
      this.revision++
    }
    this.holdAnchor()
    this.refresh()
  }

  private schedule = (): void => {
    if (this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.holdAnchor()
      this.refresh()
    })
  }

  private contentTop(element: Element): number {
    return element.getBoundingClientRect().top - this.scroll!.getBoundingClientRect().top + this.scroll!.scrollTop
  }

  /** Move the scroll by however far the anchor moved in the content. A user
   *  scroll moves the viewport, not the content, so it never counts. */
  private holdAnchor(): void {
    const anchor = this.anchor
    if (!anchor || !this.scroll) return
    if (!anchor.element.isConnected) {
      this.anchor = null
      return
    }
    const top = this.contentTop(anchor.element)
    if (!Number.isFinite(top)) return
    const shift = top - anchor.top
    if (Math.abs(shift) >= 0.5) this.scroll.scrollTop += shift
    anchor.top = top
  }

  /** The element the reader is looking at. Descend through the elements the
   *  viewport top cuts; the first one that starts at or below it is the
   *  anchor. A cut element with no element children anchors on its own top:
   *  a render's iframe draws from its top edge, so holding that edge keeps
   *  the part the reader sees in place. Spacers are never anchors — they
   *  stand for rows that are not there. */
  private pickAnchor(): ScrollAnchor | null {
    if (!this.scroll || !this.content) return null
    const viewportTop = this.scroll.getBoundingClientRect().top
    const find = (parent: Element): Element | null => {
      for (const child of parent.children) {
        if (parent === this.content && !this.nodes.has(child as HTMLElement)) continue
        const rect = child.getBoundingClientRect()
        if (!(rect.bottom > viewportTop)) continue
        if (rect.top >= viewportTop || !child.children.length) return child
        // The top can fall in a cut element's trailing padding or between
        // its children's margins, with nothing inside below it; the next
        // sibling then holds the first element below the top.
        const inner = find(child)
        if (inner) return inner
      }
      return null
    }
    const element = find(this.content)
    return element ? this.anchorAt(element) : null
  }

  private anchorAt(element: Element): ScrollAnchor | null {
    const top = this.contentTop(element)
    return Number.isFinite(top) ? { element, top } : null
  }

  private anchorKey(): string | undefined {
    const element = this.anchor?.element
    const row = element?.closest<HTMLElement>('[data-transcript-turn-id]')
    return row ? this.nodes.get(row) : undefined
  }

  private refresh(): void {
    if (!this.scroll || !this.content || this.scroll.clientHeight === 0) return
    // One content rectangle, independent of history length.
    this.origin = this.content.getBoundingClientRect().top - this.scroll.getBoundingClientRect().top + this.scroll.scrollTop
    const next = this.geometry.range(this.scroll.scrollTop + this.pendingShift - this.origin, this.scroll.clientHeight)
    // A focused control pins only its own row, not every row between that
    // control and the viewport. Selected text pins its selected range.
    const keyFor = (node: Node | null): string | undefined => {
      const element = node instanceof HTMLElement ? node : node?.parentElement
      return element?.closest<HTMLElement>('[data-transcript-turn-id]')?.dataset.transcriptTurnId
    }
    const pins = new Set<string>()
    if (this.content.contains(document.activeElement)) {
      const key = keyFor(document.activeElement)
      if (key) pins.add(key)
    }
    const selection = document.getSelection()
    if (selection && !selection.isCollapsed &&
      (this.content.contains(selection.anchorNode) || this.content.contains(selection.focusNode))) {
      const anchor = keyFor(selection.anchorNode)
      const focus = keyFor(selection.focusNode)
      const start = anchor ? this.geometry.keys.indexOf(anchor) : next.start
      const end = focus ? this.geometry.keys.indexOf(focus) : next.end - 1
      for (let index = Math.max(0, Math.min(start, end)); index <= Math.max(start, end); index++) {
        const key = this.geometry.keys[index]
        if (key) pins.add(key)
      }
    }
    // The anchor's row stays mounted until the next render re-picks it, so a
    // range change cannot recycle the element the view is held by.
    const anchorKey = this.anchorKey()
    if (anchorKey) pins.add(anchorKey)
    const pinnedKeys = [...pins]
    if (pinnedKeys.length !== this.pinnedKeys.length || pinnedKeys.some((key, index) => key !== this.pinnedKeys[index])) {
      this.pinnedKeys = pinnedKeys
    }
    const current = this.range
    if (next.start !== current.start || next.end !== current.end
      || next.before !== current.before || next.after !== current.after) this.range = next
    // While keys changed and the new rows have not rendered, the DOM is not at
    // the geometry's position; keep the old anchor until they have.
    if (!this.pendingShift) this.anchor = this.pickAnchor()
  }

  row = (node: HTMLElement, key: string) => {
    this.nodes.set(node, key)
    this.observer?.observe(node)
    return { destroy: () => { this.observer?.unobserve(node); this.nodes.delete(node) } }
  }

  top(key: string): number | undefined {
    const top = this.geometry.top(key)
    return top === undefined ? undefined : this.origin + top
  }

  async reveal(key: string): Promise<void> {
    if (!this.scroll) return
    const top = this.top(key)
    if (top === undefined) return
    this.scroll.scrollTop = top
    this.refresh()
    await tick()
    // The estimate may change when markdown and expanded cards mount.
    const measured = this.top(key)
    if (measured !== undefined && this.scroll) this.scroll.scrollTop = measured
    this.refresh()
    await tick()
  }
}

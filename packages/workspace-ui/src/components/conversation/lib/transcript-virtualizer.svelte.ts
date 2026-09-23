import { tick } from 'svelte'
import { TranscriptGeometry, type TranscriptRange } from './transcript-geometry'

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
  private adjustment = 0
  private adjustmentScheduled = false

  connect(scroll: HTMLElement, content: HTMLElement): () => void {
    this.scroll = scroll
    this.content = content
    this.observer = new ResizeObserver((entries) => {
      const anchor = this.anchor()
      let changed = false
      for (const entry of entries) {
        if (!(entry.target instanceof HTMLElement)) continue
        const node = entry.target
        const key = this.nodes.get(node)
        if (key) changed = this.geometry.measure(key, entry.borderBoxSize[0]?.blockSize ?? node.offsetHeight) || changed
      }
      if (changed) {
        this.geometry.rebuild()
        this.restoreAnchor(anchor)
        this.revision++
      }
      this.refresh()
    })
    for (const node of this.nodes.keys()) this.observer.observe(node)
    this.observer.observe(scroll)
    scroll.addEventListener('scroll', this.schedule, { passive: true })
    document.addEventListener('selectionchange', this.selectionChanged)
    content.addEventListener('focusout', this.schedule)
    this.refresh()
    return () => {
      scroll.removeEventListener('scroll', this.schedule)
      document.removeEventListener('selectionchange', this.selectionChanged)
      content.removeEventListener('focusout', this.schedule)
      this.observer?.disconnect()
      this.observer = null
      cancelAnimationFrame(this.frame)
      this.frame = 0
      this.scroll = null
      this.content = null
      this.adjustment = 0
    }
  }

  setKeys(keys: string[]): void {
    if (keys.length === this.geometry.keys.length && keys.every((key, index) => key === this.geometry.keys[index])) return
    const anchor = this.anchor()
    this.geometry.setKeys(keys)
    this.restoreAnchor(anchor)
    this.revision++
    this.refresh()
  }

  private anchor(): { key: string; top: number } | null {
    if (!this.scroll) return null
    const index = this.geometry.indexAt(this.scroll.scrollTop + this.adjustment - this.origin)
    const key = this.geometry.keys[index]
    return key === undefined ? null : { key, top: this.geometry.offsets[index] }
  }

  private restoreAnchor(anchor: { key: string; top: number } | null): void {
    if (!anchor || !this.scroll) return
    const next = this.geometry.top(anchor.key)
    if (next === undefined || next === anchor.top) return
    this.adjustment += next - anchor.top
    if (this.adjustmentScheduled) return
    this.adjustmentScheduled = true
    // Apply after the spacers grow; otherwise the browser clamps to the old
    // scrollHeight and loses the prepended page's anchor adjustment.
    void tick().then(() => {
      this.adjustmentScheduled = false
      if (this.scroll) this.scroll.scrollTop += this.adjustment
      this.adjustment = 0
      this.refresh()
    })
  }

  private selectionChanged = (): void => {
    this.schedule()
  }

  private schedule = (): void => {
    if (this.frame) return
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.refresh() })
  }

  private refresh(): void {
    if (!this.scroll || !this.content || this.scroll.clientHeight === 0) return
    // One content rectangle, independent of history length.
    this.origin = this.content.getBoundingClientRect().top - this.scroll.getBoundingClientRect().top + this.scroll.scrollTop
    // Geometry already includes measured heights, but the DOM scroll correction
    // waits for the spacers to render. Select rows at that corrected position
    // now so an overscan measurement cannot recycle the visible turn meanwhile.
    const next = this.geometry.range(this.scroll.scrollTop + this.adjustment - this.origin, this.scroll.clientHeight)
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
    const pinnedKeys = [...pins]
    if (pinnedKeys.length !== this.pinnedKeys.length || pinnedKeys.some((key, index) => key !== this.pinnedKeys[index])) {
      this.pinnedKeys = pinnedKeys
    }
    const current = this.range
    if (next.start !== current.start || next.end !== current.end
      || next.before !== current.before || next.after !== current.after) this.range = next
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

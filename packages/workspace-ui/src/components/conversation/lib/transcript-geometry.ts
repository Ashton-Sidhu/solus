export interface TranscriptRange { start: number; end: number; before: number; after: number }

/** Measured heights survive row unmounts. Scroll lookup is logarithmic and
 * never reads a rectangle for each historical message. */
export class TranscriptGeometry {
  keys: string[] = []
  offsets: number[] = [0]
  private heights = new Map<string, number>()
  private indices = new Map<string, number>()

  setKeys(keys: string[]): void {
    this.keys = keys
    this.indices = new Map(keys.map((key, index) => [key, index]))
    for (const key of this.heights.keys()) if (!this.indices.has(key)) this.heights.delete(key)
    this.rebuild()
  }

  measure(key: string, height: number): boolean {
    if (!this.indices.has(key) || !Number.isFinite(height) || height <= 0
      || Math.abs((this.heights.get(key) ?? 240) - height) < 0.5) return false
    this.heights.set(key, height)
    return true
  }

  rebuild(): void {
    const offsets = [0]
    for (const key of this.keys) offsets.push(offsets[offsets.length - 1] + (this.heights.get(key) ?? 240))
    this.offsets = offsets
  }

  get total(): number { return this.offsets[this.offsets.length - 1] }
  top(key: string): number | undefined {
    const index = this.indices.get(key)
    return index === undefined ? undefined : this.offsets[index]
  }

  indexAt(offset: number): number {
    let low = 0
    let high = this.keys.length
    while (low < high) {
      const mid = (low + high) >>> 1
      if (this.offsets[mid + 1] <= offset) low = mid + 1
      else high = mid
    }
    return Math.min(low, Math.max(0, this.keys.length - 1))
  }

  range(top: number, height: number, overscan = 600): TranscriptRange {
    if (!this.keys.length) return { start: 0, end: 0, before: 0, after: 0 }
    const start = this.indexAt(Math.max(0, top - overscan))
    const end = Math.min(this.keys.length, this.indexAt(top + height + overscan) + 1)
    return { start, end, before: this.offsets[start], after: this.total - this.offsets[end] }
  }

  slots(range: TranscriptRange, pinnedKeys: string[]): Array<{ key: string; index: number; space: number }> {
    const indices = new Set<number>()
    for (let index = range.start; index < Math.min(range.end, this.keys.length); index++) indices.add(index)
    for (const key of pinnedKeys) {
      const index = this.indices.get(key)
      if (index !== undefined) indices.add(index)
    }
    let previousEnd = 0
    return [...indices].sort((a, b) => a - b).map((index) => {
      const slot = { key: this.keys[index], index, space: this.offsets[index] - previousEnd }
      previousEnd = this.offsets[index + 1]
      return slot
    })
  }
}

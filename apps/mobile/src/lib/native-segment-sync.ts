/**
 * A native segmented control changes its own selection on a tap, before the
 * caller decides. The caller may refuse the choice (a busy review sheet), and
 * then nothing would move the control back. After each tap the adapter
 * settles: an accepted choice keeps the control as it is; a refused one
 * remounts it on the caller's selection.
 */
export interface NativeSegmentSync<Value> {
  /** The value the control chose and has not yet been compared with the caller's selection. */
  readonly chosen: { readonly value: Value } | null
  /** The control's key; a new revision remounts it on the caller's selection. */
  readonly revision: number
}

export function settleNativeSegment<Value>(sync: NativeSegmentSync<Value>, selected: Value): NativeSegmentSync<Value> {
  if (!sync.chosen) return sync
  return { chosen: null, revision: sync.chosen.value === selected ? sync.revision : sync.revision + 1 }
}

/**
 * The offset a list mounts at: the one it was left at, but no deeper than the
 * rows can now scroll. A list that came back shorter (a narrower search, a
 * refresh that dropped rows) would otherwise ask for an offset the browser
 * clamps without telling anyone, and the rows drawn would sit below an empty
 * viewport.
 */
export function startOffset(
  remembered: number,
  count: number,
  sizeOf: (index: number) => number,
  viewportHeight: number,
): number {
  if (remembered <= 0) return 0
  let total = 0
  for (let index = 0; index < count; index++) total += sizeOf(index)
  return Math.min(remembered, Math.max(0, total - viewportHeight))
}

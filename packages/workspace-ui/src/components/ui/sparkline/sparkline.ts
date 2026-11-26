/** A line through percentages (0 to 100) for a 100 × 24 box: the newest on the right. Null with fewer than two readings. */
export function sparklinePath(values: readonly number[]): string | null {
  if (values.length < 2) return null
  return values.map((value, index) => `${index ? 'L' : 'M'} ${(index / (values.length - 1)) * 100} ${(22 - (value / 100) * 20).toFixed(2)}`).join(' ')
}

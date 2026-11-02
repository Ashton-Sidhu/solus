/** Compact token count: 980, 60K, 1.2M. */
export function formatTokens(n: number): string {
  // The unit follows the rounded figure: 999,600 reads as 1M, not 1000K.
  if (Math.round(n) < 1000) return String(Math.round(n))
  const k = compactFigure(n / 1000)
  if (k < 1000) return `${k}K`
  return `${compactFigure(n / 1_000_000)}M`
}

function compactFigure(value: number): number {
  return value >= 100 ? Math.round(value) : Math.round(value * 10) / 10
}

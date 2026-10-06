/** Compact token count: 980, 60K, 1.2M. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) {
    const k = n / 1000
    return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}K`
  }
  const m = n / 1_000_000
  return `${m >= 100 ? Math.round(m) : Math.round(m * 10) / 10}M`
}

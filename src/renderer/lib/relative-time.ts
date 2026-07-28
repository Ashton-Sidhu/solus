export function relativeTime(timestamp: number): string {
  const difference = Date.now() - timestamp
  if (difference < 60_000) return 'just now'
  if (difference < 3_600_000) return `${Math.floor(difference / 60_000)}m ago`
  if (difference < 86_400_000) return `${Math.floor(difference / 3_600_000)}h ago`
  return `${Math.floor(difference / 86_400_000)}d ago`
}

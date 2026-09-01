export function formatSavedAgo(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  if (diff < 5_000) return "Last saved just now";
  if (diff < 60_000) return `Last saved ${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `Last saved ${Math.floor(diff / 60_000)}m ago`;
  return `Last saved ${Math.floor(diff / 3_600_000)}h ago`;
}

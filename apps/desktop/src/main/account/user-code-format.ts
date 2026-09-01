/** `BCDFGHJK` → `BCDF-GHJK`, the way the website shows it. Other lengths pass through. */
export function formatUserCode(code: string): string {
  const normalized = code.toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (normalized.length !== 8) return normalized
  return `${normalized.slice(0, 4)}-${normalized.slice(4)}`
}

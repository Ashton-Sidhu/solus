/** Up to two uppercase initials from a display name or login (`ashton-sidhu` → `AS`). */
export function initials(name: string): string {
  const parts = name.split(/[\s_./-]+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[1][0]).toUpperCase()
}

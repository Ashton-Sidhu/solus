/**
 * The badge a project shows when it has no favicon: its initials on a tint of
 * its own colour. Shared so desktop, web, and mobile draw the same badge for
 * the same project.
 */

/** "ts-rust" → "TR", "solus" → "SO". Empty when the name has no letter or digit. */
export function projectInitials(name: string): string {
  const [first, second] = name.match(/[\p{L}\p{N}]+/gu) ?? []
  if (!first) return ''
  const initials = second ? first.charAt(0) + second.charAt(0) : first.slice(0, 2)
  return initials.toUpperCase()
}

/** A stable hue (0–359) from the project's name. The name, not a host's key,
 *  so every client gives one project the same colour. */
export function projectBadgeHue(projectName: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < projectName.length; index++) {
    hash ^= projectName.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) % 360
}

export interface ProjectBadgeColors {
  background: string
  foreground: string
}

/** The badge's tint and ink for one appearance. HSL, because React Native
 *  cannot read OKLCH. */
export function projectBadgeColors(projectName: string, appearance: 'light' | 'dark'): ProjectBadgeColors {
  const hue = projectBadgeHue(projectName)
  return appearance === 'dark'
    ? { background: `hsl(${hue} 32% 26%)`, foreground: `hsl(${hue} 70% 82%)` }
    : { background: `hsl(${hue} 70% 92%)`, foreground: `hsl(${hue} 50% 36%)` }
}

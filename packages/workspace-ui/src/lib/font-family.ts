/**
 * Turn a user-entered family name into a safe CSS `font-family` value.
 *
 * A preference is a preset id or an installed family name (see
 * `FontFamilyPreference`). Only the second form reaches CSS, and it arrives
 * as free text: it is quoted here so a name with spaces or punctuation cannot
 * break the declaration, and prepended to the surface's default stack so
 * glyph coverage never regresses when the face lacks a character.
 */

function quoteFontFamilyName(name: string): string {
  const bare = name.trim()
  if (bare.length === 0) return ''
  // Already quoted, or a single ident that needs no quoting.
  if (/^(['"]).*\1$/.test(bare)) return bare
  if (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(bare)) return bare
  return `"${bare.replaceAll('"', '')}"`
}

/** Null when the input is effectively empty, so callers fall back cleanly. */
export function cssFontFamilies(input: string): string | null {
  const families = input
    .split(',')
    .map(quoteFontFamilyName)
    .filter((name) => name.length > 0)
  return families.length > 0 ? families.join(', ') : null
}

/** The stack a raw family renders with: the family first, the default behind it. */
export function customFamilyStack(family: string, fallbackStack: string): string {
  const list = cssFontFamilies(family)
  return list === null ? fallbackStack : `${list}, ${fallbackStack}`
}

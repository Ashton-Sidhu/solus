import { isFontFamilyAvailable, isMonospaceFamily } from './font-catalog.svelte'

export interface FontPreset {
  id: string
  label: string
}

/** The picker's trigger text: a preset's label, or the installed name itself. */
export function fontPreferenceLabel(value: string, presets: readonly FontPreset[]): string {
  return presets.find((preset) => preset.id === value)?.label ?? value
}

function matches(query: string, text: string): boolean {
  return query.length === 0 || text.toLowerCase().includes(query)
}

export function filterPresets(presets: readonly FontPreset[], query: string): FontPreset[] {
  const needle = query.trim().toLowerCase()
  return presets.filter((preset) => matches(needle, preset.label) || matches(needle, preset.id))
}

const monospaceCache = new Map<string, boolean>()

/** Memoized: the probe draws 32 glyphs per family and a picker lists hundreds. */
function isMonospaceCached(family: string): boolean {
  let known = monospaceCache.get(family)
  if (known === undefined) {
    known = isMonospaceFamily(family)
    monospaceCache.set(family, known)
  }
  return known
}

export function filterInstalledFamilies(
  families: readonly string[],
  query: string,
  requireMonospace: boolean,
): string[] {
  const needle = query.trim().toLowerCase()
  const named = families.filter((family) => matches(needle, family))
  return requireMonospace ? named.filter(isMonospaceCached) : named
}

export type TypedFamilyVerdict =
  /** Nothing typed, or the text already names a listed preset or family. */
  | { kind: 'none' }
  | { kind: 'ok'; family: string }
  | { kind: 'not-installed'; family: string }
  | { kind: 'not-monospace'; family: string }

/**
 * Whether the typed text can be committed as a family the list does not show:
 * the whole choice on engines without font enumeration, and a way past a
 * face the enumeration missed on engines with it.
 */
export function typedFamilyVerdict(
  query: string,
  presets: readonly FontPreset[],
  installed: readonly string[],
  requireMonospace: boolean,
): TypedFamilyVerdict {
  const family = query.trim()
  if (family.length === 0) return { kind: 'none' }
  const lower = family.toLowerCase()
  if (presets.some((preset) => preset.label.toLowerCase() === lower)) return { kind: 'none' }
  if (installed.some((name) => name.toLowerCase() === lower)) return { kind: 'none' }
  if (!isFontFamilyAvailable(family)) return { kind: 'not-installed', family }
  if (requireMonospace && !isMonospaceCached(family)) return { kind: 'not-monospace', family }
  return { kind: 'ok', family }
}

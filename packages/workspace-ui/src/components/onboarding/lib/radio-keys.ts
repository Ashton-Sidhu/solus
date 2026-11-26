/**
 * Arrow keys in a radio group choose the next or previous option, as a native
 * radio group does. Returns the option to choose, or null for any other key.
 */
export function radioArrowKey<T>(key: string, options: readonly T[], current: T): T | null {
  const step = key === 'ArrowDown' || key === 'ArrowRight' ? 1 : key === 'ArrowUp' || key === 'ArrowLeft' ? -1 : 0
  if (step === 0 || options.length === 0) return null
  const index = options.indexOf(current)
  return options[(index + step + options.length) % options.length] ?? null
}

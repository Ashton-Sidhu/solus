let collator: Intl.Collator | null = null

/**
 * Natural, case-insensitive order for file names and paths: `file2` before
 * `file10`, `a` beside `A`. A project listing sorts up to 25k paths, and
 * `localeCompare` with options builds its collator on every comparison, so one
 * collator is built on first use and kept.
 */
export function compareFileNames(left: string, right: string): number {
  collator ??= new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
  return collator.compare(left, right)
}

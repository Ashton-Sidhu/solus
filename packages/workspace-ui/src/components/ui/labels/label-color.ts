/**
 * The host's label colour as a CSS colour. GitHub reports bare hex
 * (`0e8a16`), which as a style value paints nothing; a provider that reports
 * a CSS colour keeps it. The chip mixes this with the page's own background
 * and foreground, so one saturated host colour reads as a pastel in both
 * themes rather than as a block the title has to compete with.
 */
export function labelChipColor(color: string): string {
  const trimmed = color.trim()
  if (!trimmed) return 'var(--muted-foreground)'
  return /^[0-9a-f]{3,8}$/i.test(trimmed) ? `#${trimmed}` : trimmed
}

/** The tint a chip or a picker row draws: the host's colour when the label
 *  has one, the brand accent for a label with none (a local task label). */
export function labelTint(color: string | undefined): string {
  return color === undefined ? 'var(--solus-accent)' : labelChipColor(color)
}

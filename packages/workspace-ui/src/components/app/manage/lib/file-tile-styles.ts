import type { FileTileTone } from './app-file-list'

/** The colors of a file's type tile, from the art palette, so both themes read them. */
export const FILE_TILE_TONES = {
  document: 'bg-[color-mix(in_oklch,var(--solus-art-1)_12%,transparent)] text-[color-mix(in_oklch,var(--solus-art-1)_78%,var(--foreground))]',
  data: 'bg-[color-mix(in_oklch,var(--solus-art-3)_14%,transparent)] text-[color-mix(in_oklch,var(--solus-art-3)_65%,var(--foreground))]',
  image: 'bg-[color-mix(in_oklch,var(--solus-art-5)_12%,transparent)] text-[color-mix(in_oklch,var(--solus-art-5)_75%,var(--foreground))]',
  markup: 'bg-[color-mix(in_oklch,var(--solus-art-2)_16%,transparent)] text-[color-mix(in_oklch,var(--solus-art-2)_60%,var(--foreground))]',
  plain: 'bg-[var(--wash-2)] text-(--solus-text-secondary)',
} satisfies { [Tone in FileTileTone]: string }

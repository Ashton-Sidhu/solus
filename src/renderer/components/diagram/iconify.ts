import { addIcon } from '@iconify/svelte'

// Register the build-time curated offline subset lazily. Arbitrary Iconify
// names continue to resolve through Iconify's API fallback without making Files,
// Diff, or PR surfaces parse both complete 12 MB collections. Names included
// locally include:
//   logos:postgresql      → full-colour product logo
//   simple-icons:redis    → monochrome glyph (inherits currentColor)
let registration: Promise<void> | null = null

export function ensureIconCollections(): Promise<void> {
  if (!registration) {
    registration = import('virtual:solus-icons').then(({ default: icons }) => {
      for (const icon of icons) addIcon(icon.name, icon.data)
    })
  }
  return registration
}

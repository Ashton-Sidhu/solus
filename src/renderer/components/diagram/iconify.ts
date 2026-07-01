import { addCollection, type IconifyJSON } from '@iconify/svelte'

// Brand/service/protocol icon sets (logos + simple-icons) total ~12MB of JSON.
// Importing them statically pulled that whole payload into the main renderer
// bundle and parsed it at app startup — even when no diagram was ever opened.
// Register them lazily on first diagram render instead, via a code-split dynamic
// import, so the cost is paid once and only when a diagram actually mounts. Names
// resolved offline once registered:
//   logos:postgresql      → full-colour product logo
//   simple-icons:redis    → monochrome glyph (inherits currentColor)
// Any name not in these sets still resolves via the Iconify API as a fallback,
// and @iconify/svelte re-renders icons when the collection finishes registering.
let registration: Promise<void> | null = null

export function ensureIconCollections(): Promise<void> {
  if (!registration) {
    registration = Promise.all([
      import('@iconify-json/logos/icons.json'),
      import('@iconify-json/simple-icons/icons.json'),
    ]).then(([logos, simpleIcons]) => {
      addCollection(logos.default as IconifyJSON)
      addCollection(simpleIcons.default as IconifyJSON)
    })
  }
  return registration
}

import { EDITOR_IDS, TERMINAL_APP_IDS, type EditorId, type TerminalAppId } from '@solus/contracts/types'

/**
 * The real macOS application icons, committed under `../app-icons` by
 * `bun run generate:app-icons`. These are the artwork the user sees in their
 * Dock, which no third-party glyph set matches.
 *
 * Globbed rather than listed so running the generator after installing another
 * editor or terminal is the whole change — nothing here needs editing. An app
 * with no committed icon falls back to its brand mark in `app-logos.ts`.
 *
 * Kept apart from `app-logos.ts` on purpose: that module is imported by the
 * build-time Iconify plugin, which runs in Node where `import.meta.glob` does
 * not exist.
 */
const iconUrlByPath = import.meta.glob<string>('../app-icons/*.png', {
  eager: true,
  query: '?url',
  import: 'default',
})

const APP_IDS: readonly (EditorId | TerminalAppId)[] = [...EDITOR_IDS, ...TERMINAL_APP_IDS]

function appIdForIconPath(path: string): EditorId | TerminalAppId | undefined {
  const fileName = path.slice(path.lastIndexOf('/') + 1, -'.png'.length)
  // A file named for something that is not an app is ignored rather than
  // trusted, so a stray asset cannot masquerade as an id.
  return APP_IDS.find((id) => id === fileName)
}

export const APP_ICONS: ReadonlyMap<EditorId | TerminalAppId, string> = new Map(
  Object.entries(iconUrlByPath).flatMap(([path, url]) => {
    const id = appIdForIconPath(path)
    return id ? [[id, url] as const] : []
  }),
)

import { joinHostPath, trimTrailingSeparators } from '@solus/contracts/host-path'

/** Filenames a project may keep its own mark under, in the order we prefer. */
const FAVICON_FILENAMES = [
  'favicon.ico',
  'favicon.svg',
  'favicon.png',
  'favicon.webp',
  'favicon.jpg',
  'favicon.jpeg',
]

/** Common nested locations. Keep this list short: root-level files remain the
 * unambiguous project-owned convention. */
const NESTED_FAVICON_PATHS = [
  'public/favicon.ico',
  'static/favicon.ico',
  'apps/web/public/favicon.ico',
]

/** The host paths a project's favicon may live at, in preference order. Every
 *  client asks the project's host for the first one it can serve. */
export function faviconCandidatePaths(projectRoot: string): string[] {
  // In the host's own separator, so the path the host answers with is one it names.
  return [...FAVICON_FILENAMES, ...NESTED_FAVICON_PATHS].map((name) => joinHostPath(projectRoot, name))
}

export function normalizedProjectRoot(projectRoot: string): string {
  return trimTrailingSeparators(projectRoot)
}

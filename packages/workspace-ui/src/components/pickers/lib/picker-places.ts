import type { DirectoryListResult } from '@solus/contracts/types'
import { SCRATCHPAD_LABEL } from '../../../lib/paths'
import {
  appendPathSegment,
  breadcrumbTrail,
  ensureDirectoryPath,
  type BrowsePathPlatform,
} from './browse-path'

/** Glyph a Places row carries — what kind of location it is, not its label. */
export type PlaceIcon = 'workspace' | 'home' | 'folder' | 'recent'

export interface Place {
  label: string
  path: string
  icon: PlaceIcon
}

const STANDARD_HOME_FOLDERS = ['Desktop', 'Documents', 'Downloads']

/** The fixed Places a host offers, from its capabilities and a listing of `~`. */
export function placesFor(
  platform: BrowsePathPlatform,
  capabilities: { projectsBaseDirectory?: string; workspacePath?: string } | null,
  home: DirectoryListResult | null,
): Place[] {
  const homePath = ensureDirectoryPath('~', platform)
  const projectsPath = capabilities?.projectsBaseDirectory
    ? ensureDirectoryPath(capabilities.projectsBaseDirectory, platform)
    : null
  const resolvedHomePath = home?.currentPath
    ? ensureDirectoryPath(home.currentPath, platform)
    : homePath
  const filesystemRoot = breadcrumbTrail(resolvedHomePath, platform)[0]?.path
  const places: Place[] = []
  // Scratchpad pins to the top: the host's chat folder, always present
  // there, and never surfaces in recents.
  if (capabilities?.workspacePath) {
    places.push({
      label: SCRATCHPAD_LABEL,
      path: ensureDirectoryPath(capabilities.workspacePath, platform),
      icon: 'workspace',
    })
  }
  if (projectsPath && projectsPath !== homePath && projectsPath !== resolvedHomePath) {
    places.push({ label: 'Projects', path: projectsPath, icon: 'folder' })
  }
  places.push({ label: 'Home', path: homePath, icon: 'home' })
  if (filesystemRoot && filesystemRoot !== homePath && filesystemRoot !== resolvedHomePath) {
    places.push({
      label: platform === 'win32' ? filesystemRoot : 'Root',
      path: filesystemRoot,
      icon: 'folder',
    })
  }
  for (const name of STANDARD_HOME_FOLDERS) {
    if (!home?.entries.some((entry) => entry.isDir && entry.name === name)) continue
    places.push({ label: name, path: appendPathSegment(homePath, name, platform), icon: 'folder' })
  }
  return places
}

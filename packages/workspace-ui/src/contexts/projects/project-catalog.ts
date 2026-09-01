import { worktreeProjectRoot } from '@solus/contracts/types'
import { hostKey } from '@solus/client-core/host-key'

/**
 * Canonical client-side project identity: a host and the repo root on it.
 * Equal paths on different hosts are distinct projects — never dedupe across
 * `serverId`.
 */
export interface ProjectRef {
  serverId: string
  projectRoot: string
}

/** The project authority shared by the four project-scoped pages. A page owns
 * this value while it is open, so a hidden chat cannot retarget it. */
export type ProjectPageScope =
  | { kind: 'all' }
  | { kind: 'project'; project: ProjectRef }

/** A project the catalog has recorded, with when it was last touched. */
export interface ProjectCatalogEntry extends ProjectRef {
  label: string
  lastSeenAt: number
}

/** One row a page-level project picker can show — catalog, sidebar, and
 *  domain projects merged into one shape. `available` is false when the
 *  option cannot be safely selected from where it is shown (its host is
 *  disconnected, or the picker has no way to route to that host yet) — the
 *  option stays visible, but the picker must not silently act on it. */
export interface ProjectPickerOption extends ProjectRef {
  /** Unique across hosts — `hostKey(serverId, projectRoot)`. */
  key: string
  label: string
  available: boolean
}

/** Strips Solus worktree-marker segments and a trailing slash so a worktree
 *  checkout or a path typed with a trailing separator collapses to the same
 *  key as its project root. */
export function normalizeProjectRoot(path: string): string {
  const stripped = worktreeProjectRoot(path)
  return stripped.length > 1 ? stripped.replace(/\/+$/, '') : stripped
}

export function projectRefKey(ref: ProjectRef): string {
  return hostKey(ref.serverId, ref.projectRoot)
}

/** One project as a picker source hands it in, before merge/dedupe/label
 *  disambiguation. */
export interface ProjectOptionSource extends ProjectRef {
  label: string
}

/**
 * Merges any number of project-option sources into one deduplicated-by-
 * `(serverId, projectRoot)` list. Sources are given in priority order — the
 * first source to name a key keeps its label. A label shared by two
 * different hosts gets a " · <host>" suffix so same-named (or same-path)
 * projects on two machines read as distinct rows instead of duplicates.
 */
export function mergeProjectOptions(
  sources: ProjectOptionSource[][],
  isAvailable: (serverId: string) => boolean,
  hostLabelFor: (serverId: string) => string,
): ProjectPickerOption[] {
  const byKey = new Map<string, ProjectPickerOption>()
  for (const source of sources) {
    for (const project of source) {
      if (!project.projectRoot || project.projectRoot === '~') continue
      const key = projectRefKey(project)
      if (byKey.has(key)) continue
      byKey.set(key, {
        serverId: project.serverId,
        projectRoot: project.projectRoot,
        key,
        label: project.label,
        available: isAvailable(project.serverId),
      })
    }
  }

  const list = [...byKey.values()]
  const labelCounts = new Map<string, number>()
  for (const option of list) labelCounts.set(option.label, (labelCounts.get(option.label) ?? 0) + 1)
  for (const option of list) {
    if ((labelCounts.get(option.label) ?? 0) < 2) continue
    option.label = `${option.label} · ${hostLabelFor(option.serverId)}`
  }
  return list.sort((a, b) => a.label.localeCompare(b.label))
}

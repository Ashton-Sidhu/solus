import type { Codebase } from '@solus/contracts/codebases'
import type { Place } from '@solus/contracts/types'
import { hostPathBaseName, isInsideHostPath, sameHostPath } from '@solus/contracts/host-path'

/**
 * The codebases of the project chip (docs/plans/codebases.md §9, "Start").
 * The chip has one choice: a run is in a project, or it is in a codebase. A
 * run that has a codebase shows the codebase, and each other run shows the
 * project. The chip never shows the two names, and its list never marks two
 * rows.
 *
 * A project is one folder or one repository, and a codebase is two or more
 * projects or one container, so a project is never also a codebase. A row of
 * a codebase shows the favicons of its folders and its name, with no count.
 * Its tooltip has the details: each folder with its host.
 *
 * A choice of a codebase sets the codebase of the run. The folder of the run
 * stays when the codebase holds it; else the run opens the first root of the
 * codebase on the run host. A choice of a container codebase opens the
 * container folder: a session of a container works there. A root names its
 * host by an installation id, so the caller says which host of this client
 * that is.
 */

/** A host of this client that a root names. */
export interface CodebaseChipHost {
  serverId: string
  label: string
  isReady: boolean
}

/** One root that the chip can open: a folder on a host of this client. */
export interface CodebaseChipRoot extends Place {
  name: string
  /** The root is a container: its repositories are the folders of the codebase there. */
  container: boolean
}

/** One folder of a codebase, as its row and its tooltip show it. */
export interface CodebaseChipFolder {
  name: string
  /** The name of its host. Null for a host that this client does not know. */
  hostLabel: string | null
  /** Where the folder is on a host of this client: its favicon is read there. Null for a host that this client does not know. */
  place: Place | null
}

/** A row shows the favicons of at most this many folders. */
export const CODEBASE_FAVICONS_MAX = 3
/** A tooltip names at most this many folders, then the count of the others. */
export const CODEBASE_TOOLTIP_FOLDERS_MAX = 8

export interface CodebaseChipHostRoots extends CodebaseChipHost {
  roots: CodebaseChipRoot[]
}

export interface CodebaseChipOption {
  id: string
  name: string
  /** The run starts with this codebase. */
  isCurrent: boolean
  /** The project folder of the run is in this codebase on the run host: a choice keeps the folder. */
  holdsProject: boolean
  /** The roots on the run host. */
  roots: CodebaseChipRoot[]
  /** The other hosts of this client that have a root, each with its roots. */
  otherHosts: CodebaseChipHostRoots[]
  /**
   * The container root on the run host that holds the project folder of the
   * run and is not that folder. A choice opens it.
   */
  containerAbove: CodebaseChipRoot | null
  /**
   * The folders of the codebase, in the order of its roots: each root, and
   * for a container root that its host read, the repositories inside it.
   */
  folders: CodebaseChipFolder[]
  /** Said beside the name, only when the run host has no folder of this codebase. */
  note: string | null
}

/** What a choice of one codebase row does next. */
export type CodebaseChoiceStep =
  /** Set the codebase. The folder of the run stays. */
  | { kind: 'keep' }
  /** Set the codebase and open this root: the first root of the codebase on the run host. */
  | { kind: 'open'; root: CodebaseChipRoot }
  /** The run host has no folder: the person chooses a host that has one, and the run moves there. */
  | { kind: 'hosts'; hosts: CodebaseChipHostRoots[] }
  /** No host of this client has a folder of the codebase. */
  | { kind: 'none' }

export const NO_FOLDER_ON_HOST_NOTE = 'No folder on this host'
export const NO_FOLDER_ON_CLIENT_NOTE = 'No folder on a connected host'

interface ChipRun {
  /** The host the run is on. */
  serverId: string
  /** The project folder of the run on that host, or null while it has none. */
  projectPath: string | null
  /** The codebase the run starts with. */
  codebaseId: string | null
}

/**
 * One row for each codebase, in the order of the store (by name). A codebase
 * whose roots are all on hosts that this client does not know stays in the
 * list, so the person sees why it cannot open.
 */
export function codebaseChipOptions(
  codebases: readonly Codebase[],
  run: ChipRun,
  hostOf: (installationId: string) => CodebaseChipHost | null,
  /** The paths of the repositories that the host of a container root found inside it, or null when that host did not read them. */
  repositoriesIn: (codebaseId: string, root: CodebaseChipRoot) => readonly string[] | null = () => null,
): CodebaseChipOption[] {
  return codebases.map((codebase): CodebaseChipOption => {
    const byHost = new Map<string, CodebaseChipHostRoots>()
    const folders: CodebaseChipFolder[] = []
    for (const root of codebase.roots) {
      const host = hostOf(root.installationId)
      const name = root.name || hostPathBaseName(root.path) || root.path
      if (!host) {
        folders.push({ name, hostLabel: null, place: null })
        continue
      }
      const chipRoot: CodebaseChipRoot = { serverId: host.serverId, path: root.path, name, container: root.container === true }
      const entry = byHost.get(host.serverId) ?? { ...host, roots: [] }
      byHost.set(host.serverId, entry)
      entry.roots.push(chipRoot)
      folders.push(...foldersOfRoot(chipRoot, host.label, chipRoot.container ? repositoriesIn(codebase.id, chipRoot) : null))
    }
    const roots = byHost.get(run.serverId)?.roots ?? []
    const otherHosts = [...byHost.values()].filter((host) => host.serverId !== run.serverId)
    const holder = holderOf(roots, run.projectPath)
    return {
      id: codebase.id,
      name: codebase.name,
      isCurrent: codebase.id === run.codebaseId,
      holdsProject: holder !== null,
      roots,
      otherHosts,
      containerAbove: holder?.container && !sameHostPath(holder.path, run.projectPath ?? '') ? holder : null,
      folders,
      note: noteOf(roots.length, otherHosts.length),
    }
  })
}

/** The folders that one root on a host of this client adds: the repositories that its host found in a container, else the root itself. */
function foldersOfRoot(root: CodebaseChipRoot, hostLabel: string, repositories: readonly string[] | null): CodebaseChipFolder[] {
  if (!repositories?.length) return [{ name: root.name, hostLabel, place: { serverId: root.serverId, path: root.path } }]
  return repositories.map((path) => ({ name: hostPathBaseName(path) || path, hostLabel, place: { serverId: root.serverId, path } }))
}

/** The root on the run host that holds the project folder of the run, or null. */
function holderOf(roots: readonly CodebaseChipRoot[], projectPath: string | null): CodebaseChipRoot | null {
  return projectPath ? roots.find((root) => isInsideHostPath(root.path, projectPath)) ?? null : null
}

function noteOf(rootsOnRunHost: number, otherHosts: number): string | null {
  if (rootsOnRunHost > 0) return null
  return otherHosts > 0 ? NO_FOLDER_ON_HOST_NOTE : NO_FOLDER_ON_CLIENT_NOTE
}

/** The places whose favicons the row of a codebase shows: its first folders on hosts of this client, at most `CODEBASE_FAVICONS_MAX`. */
export function codebaseFavicons(folders: readonly CodebaseChipFolder[]): Place[] {
  return folders.flatMap((folder) => folder.place ? [folder.place] : []).slice(0, CODEBASE_FAVICONS_MAX)
}

/** The details of a codebase, as the tooltip of its row and of the chip shows them: one line for the name, then one for each folder. */
export interface CodebaseTooltip {
  name: string
  /** One line for each folder: its name, and its host. `host` is null for a host that this client does not know. */
  folders: { name: string; host: string | null }[]
  /** The folders after `CODEBASE_TOOLTIP_FOLDERS_MAX`, as a count. */
  more: number
}

export function codebaseTooltip(codebase: Pick<CodebaseChipOption, 'name' | 'folders'>): CodebaseTooltip {
  return {
    name: codebase.name,
    folders: codebase.folders.slice(0, CODEBASE_TOOLTIP_FOLDERS_MAX).map((folder) => ({ name: folder.name, host: folder.hostLabel })),
    more: Math.max(0, codebase.folders.length - CODEBASE_TOOLTIP_FOLDERS_MAX),
  }
}

/**
 * What happens when the person chooses `option`. A container codebase opens
 * its container folder, because a session of a container works there. A
 * codebase with more than one root on the run host opens the first one, with
 * no second step: the person changes the working folder with a row of the
 * Projects group.
 */
export function codebaseChoiceStep(option: CodebaseChipOption): CodebaseChoiceStep {
  if (option.containerAbove) return { kind: 'open', root: option.containerAbove }
  if (option.holdsProject) return { kind: 'keep' }
  if (option.roots.length > 0) return { kind: 'open', root: option.roots[0]! }
  return option.otherHosts.length > 0 ? { kind: 'hosts', hosts: option.otherHosts } : { kind: 'none' }
}

/**
 * The codebase that a run gets with no step by the person, when its project
 * folder changes: the one codebase that holds the folder on the run host.
 *
 * - `undefined`: nothing is decided. The host has not answered its codebases,
 *   or no codebase holds the folder now: the host forms the codebase of a
 *   container when the folder is opened, and that codebase then applies.
 * - `null`: nothing to set. The run has a codebase already, or the folder is
 *   in more than one and the person chooses.
 */
export function automaticCodebase(current: string | null, holding: readonly Codebase[] | null): string | null | undefined {
  if (current) return null
  if (!holding || holding.length === 0) return undefined
  return holding.length === 1 ? holding[0]!.id : null
}

/** The one name that the chip shows at rest. */
export interface ChipAtRest {
  /** `codebase`: the run has a codebase, and the name is its name. `project`: the name is the name of the project. */
  kind: 'codebase' | 'project'
  name: string
  /**
   * Said beside the name of a project, never beside a codebase: that more
   * than one codebase holds the folder, so the person must choose one. It is
   * a note about the project, not a second name.
   */
  note: string | null
}

/** What the chip reads of a run that has no codebase. */
export interface ChipProjectRun {
  /** The codebases that hold the project folder on the run host. */
  holding?: readonly Codebase[]
  /** The person chose "No codebase": the chip shows the project with no note. */
  refuses?: boolean
}

/**
 * What the chip shows at rest: the codebase of the run, else its project.
 * `current` is the record of the codebase of the run. A run whose codebase
 * this client has no record of shows its project, because the client has no
 * name for the codebase.
 */
export function chipAtRest(projectLabel: string, current: Codebase | undefined, run: ChipProjectRun = {}): ChipAtRest {
  if (current) return { kind: 'codebase', name: current.name, note: null }
  const asksChoice = !run.refuses && (run.holding?.length ?? 0) > 1
  return {
    kind: 'project',
    name: projectLabel,
    note: asksChoice ? 'Choose codebase' : null,
  }
}

/**
 * True for the one row of the Projects group that the list marks: the row of
 * the project of the run, and only while the chip shows the project. A run
 * that has a codebase marks its codebase row, and no project row.
 */
export function marksProjectRow(chip: ChipAtRest, rowKey: string, currentProjectKey: string): boolean {
  return chip.kind === 'project' && rowKey === currentProjectKey
}

/**
 * The sentence of the chip tooltip after its first one. The chip of a
 * codebase run does not show the working folder, so the tooltip says where
 * the run works.
 */
export function chipHint(chip: ChipAtRest, works: { folder: string; host: string }): string | null {
  return chip.kind === 'codebase' ? `Works in ${works.folder} on ${works.host}.` : null
}

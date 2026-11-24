import type { Codebase, CodebaseFolderScan } from '@solus/contracts/codebases'
import { repositoriesFoundIn } from '@solus/client-core/codebases'
import { hostPathBaseName } from '@solus/contracts/host-path'
import type { Place } from '@solus/contracts/types'
import { isInsideHostPath } from '@solus/contracts/host-path'

/**
 * The codebases of the project chip (docs/plans/codebases.md §9, "Start").
 * The chip has one choice: a run is in a project, or it is in a codebase. A
 * run that has a codebase shows the codebase, and each other run shows the
 * project. The chip never shows the two names, and its list never marks two
 * rows.
 *
 * A choice of a codebase sets the codebase of the run. The folder of the run
 * stays when the codebase holds it; else the run opens the first root of the
 * codebase on the run host. A root names its host by an installation id, so
 * the caller says which host of this client that is.
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
}

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
   * Said beside the name: that the run host has no folder of this codebase,
   * else how many repositories it covers there, when that host read them.
   */
  note: string | null
}

/**
 * The codebase that the host makes for the project folder of a draft at its
 * first prompt (docs/plans/codebases.md decision 13). It has no record yet,
 * so it is not in the list of the store.
 */
export interface NewCodebaseOption {
  /** The name of the project folder. The host adds a number when a codebase has that name. */
  name: string
  /** The row note: that the codebase is new, and how many repositories the folder holds. */
  note: string
  /**
   * The host makes it at the first prompt. False when the person chose "No
   * codebase": the row is then the way back. The row is never the current row
   * of the list, because the run is in the project until the codebase exists.
   */
  willForm: boolean
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
/** The note of the chip beside the project of a draft whose folder gets a new codebase. */
export const NEW_CODEBASE_LABEL = 'New codebase'
/** The full sentence for the tooltip of the chip and the title of the row. */
export const NEW_CODEBASE_HINT = 'Solus makes this codebase when you send the first prompt.'

export function repositoryCountNote(count: number): string {
  return `${count} ${count === 1 ? 'repository' : 'repositories'}`
}

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
  /** The repositories that a codebase covers on the run host, or null when that host did not read them. */
  repositoryCountOf: (codebaseId: string) => number | null = () => null,
): CodebaseChipOption[] {
  return codebases.map((codebase): CodebaseChipOption => {
    const byHost = new Map<string, CodebaseChipHostRoots>()
    for (const root of codebase.roots) {
      const host = hostOf(root.installationId)
      if (!host) continue
      let entry = byHost.get(host.serverId)
      if (!entry) {
        entry = { ...host, roots: [] }
        byHost.set(host.serverId, entry)
      }
      entry.roots.push({ serverId: host.serverId, path: root.path, name: root.name })
    }
    const roots = byHost.get(run.serverId)?.roots ?? []
    const otherHosts = [...byHost.values()].filter((host) => host.serverId !== run.serverId)
    const repositoryCount = roots.length > 0 ? repositoryCountOf(codebase.id) : null
    return {
      id: codebase.id,
      name: codebase.name,
      isCurrent: codebase.id === run.codebaseId,
      holdsProject: !!run.projectPath && roots.some((root) => isInsideHostPath(root.path, run.projectPath!)),
      roots,
      otherHosts,
      note: roots.length > 0
        ? repositoryCount === null ? null : repositoryCountNote(repositoryCount)
        : otherHosts.length > 0 ? NO_FOLDER_ON_HOST_NOTE : NO_FOLDER_ON_CLIENT_NOTE,
    }
  })
}

/**
 * The row of the codebase that the host makes for the folder of a draft.
 * `scan` is `CodebasesStore.newCodebaseAt`: null when the host makes none.
 * `refuses` says that the person chose "No codebase" for the run.
 */
export function newCodebaseOption(scan: CodebaseFolderScan | null, refuses: boolean): NewCodebaseOption | null {
  if (!scan) return null
  return {
    name: hostPathBaseName(scan.path) || scan.path,
    note: `New · ${repositoryCountNote(repositoriesFoundIn(scan).length)}`,
    willForm: !refuses,
  }
}

/**
 * What happens when the person chooses `option`. A codebase with more than
 * one root on the run host opens the first one, with no second step: the
 * person changes the working folder with a row of the Projects group.
 */
export function codebaseChoiceStep(option: CodebaseChipOption): CodebaseChoiceStep {
  if (option.holdsProject) return { kind: 'keep' }
  if (option.roots.length > 0) return { kind: 'open', root: option.roots[0]! }
  return option.otherHosts.length > 0 ? { kind: 'hosts', hosts: option.otherHosts } : { kind: 'none' }
}

/**
 * The codebase that a run gets with no step by the person, when its project
 * folder changes: the one codebase that holds the folder on the run host.
 *
 * - `undefined`: the host has not answered its codebases, so nothing is decided.
 * - `null`: nothing to set. The run has a codebase already, or the folder is
 *   in no codebase, or it is in more than one and the person chooses.
 */
export function automaticCodebase(current: string | null, holding: readonly Codebase[] | null): string | null | undefined {
  if (current) return null
  if (!holding) return undefined
  return holding.length === 1 ? holding[0]!.id : null
}

/** The one name that the chip shows at rest. */
export interface ChipAtRest {
  /** `codebase`: the run has a codebase, and the name is its name. `project`: the name is the name of the project. */
  kind: 'codebase' | 'project'
  name: string
  /**
   * Said beside the name of a project, never beside a codebase: that the host
   * makes a codebase at the first prompt, or that the person must choose one.
   * It is a note about the project, not a second name.
   */
  note: string | null
}

/** What the chip reads of a run that has no codebase. */
export interface ChipProjectRun {
  /** The codebases that hold the project folder on the run host. */
  holding?: readonly Codebase[]
  /** The codebase that the host makes for the folder at the first prompt. */
  newCodebase?: NewCodebaseOption | null
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
    note: run.newCodebase?.willForm ? NEW_CODEBASE_LABEL : asksChoice ? 'Choose codebase' : null,
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
 * the run works. For a draft whose folder gets a new codebase, it says that
 * the host makes the codebase.
 */
export function chipHint(chip: ChipAtRest, works: { folder: string; host: string }): string | null {
  if (chip.kind === 'codebase') return `Works in ${works.folder} on ${works.host}.`
  return chip.note === NEW_CODEBASE_LABEL ? NEW_CODEBASE_HINT : null
}

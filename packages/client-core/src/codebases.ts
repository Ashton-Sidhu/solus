import { CODEBASE_ROOTS_MAX, type Codebase, type CodebaseFolderScan, type CodebaseMember, type CodebaseRoot } from '@solus/contracts/codebases'
import { hostPathBaseName, hostPathKey, isInsideHostPath } from '@solus/contracts/host-path'

/**
 * The merge rule of codebases across hosts (docs/plans/codebases.md decision 6).
 * Each host keeps the full record of each codebase. A client reads the copies
 * of each connected host (deleted ones included), and this function answers
 * which copy of each codebase is the current one and what each host must be
 * sent. Pure: desktop, web, and mobile share it, and the store that calls it
 * owns the reads and the sends.
 */
export interface MergedCodebases {
  /** The newest copy of each codebase, by id. A deleted codebase is here as its tombstone. */
  codebases: Codebase[]
  /** For each host, the copies it must be sent: it has none, or it has an older one. A host with nothing to get is not a key. */
  stale: Map<string, Codebase[]>
}

/**
 * `copiesByHost`: for each host, the copies it answered, deleted ones
 * included. The newest `updatedAt` wins, so a tombstone wins over an older
 * live copy and a newer live copy wins over a tombstone. Two copies with the
 * same `updatedAt` are the same record (a host never changes a copy it
 * stores), so neither host is sent anything.
 */
export function mergeCodebases(copiesByHost: Map<string, Codebase[]>): MergedCodebases {
  const newest = new Map<string, Codebase>()
  for (const copies of copiesByHost.values()) {
    for (const copy of copies) {
      const current = newest.get(copy.id)
      if (!current || copy.updatedAt > current.updatedAt) newest.set(copy.id, copy)
    }
  }
  const codebases = [...newest.values()].sort((a, b) => a.id.localeCompare(b.id))
  const stale = new Map<string, Codebase[]>()
  for (const [hostId, copies] of copiesByHost) {
    const updatedAtById = new Map(copies.map((copy) => [copy.id, copy.updatedAt]))
    const missing = codebases.filter((codebase) => (updatedAtById.get(codebase.id) ?? -1) < codebase.updatedAt)
    if (missing.length) stale.set(hostId, missing)
  }
  return { codebases, stale }
}

/**
 * The rules of a codebase record on a client (docs/plans/codebases.md §3 and
 * §9). Pure: the store of each client owns the reads and the sends, and
 * desktop, web, and mobile use this one copy.
 */

/** Why a folder cannot become a root of a codebase. */
export type CodebaseRootRefusal = 'duplicate' | 'limit' | 'missing'

const ROOT_REFUSAL_TEXT = {
  duplicate: 'This folder is already in the codebase.',
  limit: `A codebase has at most ${CODEBASE_ROOTS_MAX} folders. Remove a folder before you add a new one.`,
  missing: 'This folder does not exist on the host.',
} satisfies Record<CodebaseRootRefusal, string>

export function rootRefusalText(refusal: CodebaseRootRefusal): string {
  return ROOT_REFUSAL_TEXT[refusal]
}

/** A command refused a root. `message` is text for the person. */
export class CodebaseRootRefused extends Error {
  constructor(readonly refusal: CodebaseRootRefusal) {
    super(ROOT_REFUSAL_TEXT[refusal])
    this.name = 'CodebaseRootRefused'
  }
}

type RootPlace = Pick<CodebaseRoot, 'installationId' | 'path'>

/** One key for every spelling of a root: its host and its path. */
export function codebaseRootKey(root: RootPlace): string {
  return `${root.installationId}\n${hostPathKey(root.path)}`
}

export function isSameRoot(a: RootPlace, b: RootPlace): boolean {
  return codebaseRootKey(a) === codebaseRootKey(b)
}

/** Why `root` cannot be added to these roots, or null when it can. */
export function rootRefusal(roots: readonly CodebaseRoot[], root: RootPlace): CodebaseRootRefusal | null {
  if (roots.some((existing) => isSameRoot(existing, root))) return 'duplicate'
  if (roots.length >= CODEBASE_ROOTS_MAX) return 'limit'
  return null
}

/** The root for a folder on a host, named by its last path name. */
export function rootFor(installationId: string, path: string): CodebaseRoot {
  return { installationId, path, name: hostPathBaseName(path) || path }
}

/**
 * The `updatedAt` of a change made now. The newest copy wins on each host, so
 * a change is always newer than the copy it replaces, also when a host with a
 * faster clock wrote that copy.
 */
export function nextUpdatedAt(current: Codebase | undefined, now: number): number {
  return current ? Math.max(now, current.updatedAt + 1) : now
}

/** The codebases that are not deleted, by name. */
export function liveCodebases(copies: Iterable<Codebase>): Codebase[] {
  return [...copies]
    .filter((codebase) => codebase.deletedAt === null)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

/** The installation ids that the roots name, each one time, in the order of the roots. */
export function rootInstallationIds(codebase: Codebase): string[] {
  return [...new Set(codebase.roots.map((root) => root.installationId))]
}

/** The roots of a codebase on one host, as one comparable text: a change of it means the members must be read again. */
export function hostRootsKey(codebase: Codebase, installationId: string): string {
  return codebase.roots
    .filter((root) => root.installationId === installationId)
    .map((root) => hostPathKey(root.path))
    .join('\n')
}

/** The codebases that hold `path` on the host `installationId`: `path` is a root, or it is inside a root. */
export function codebasesHolding(codebases: readonly Codebase[], installationId: string, path: string): Codebase[] {
  return codebases.filter((codebase) =>
    codebase.deletedAt === null
    && codebase.roots.some((root) => root.installationId === installationId && isInsideHostPath(root.path, path)))
}

/** The repositories that a scan found inside its folder. The folder itself is not one of them. */
export function repositoriesFoundIn(scan: Pick<CodebaseFolderScan, 'members'>): CodebaseMember[] {
  return scan.members.filter((member) => member.discovered && member.state === 'git')
}

/**
 * Whether the host makes a codebase for a folder at the first prompt of a
 * session there (docs/plans/codebases.md decision 13, rule 2), as a client
 * can tell before Send from the copies it knows and the scan of the folder.
 * True when the folder holds a repository, no live codebase holds the folder,
 * and no deleted codebase has it as a root (a person removed that one). The
 * host also makes none for a home directory and for a projects root, which a
 * client cannot tell.
 */
export function formsCodebaseFor(copies: Iterable<Codebase>, installationId: string, scan: CodebaseFolderScan): boolean {
  if (repositoriesFoundIn(scan).length === 0) return false
  const all = [...copies]
  if (codebasesHolding(all, installationId, scan.path).length > 0) return false
  const folder = { installationId, path: scan.path }
  return !all.some((codebase) => codebase.deletedAt !== null && codebase.roots.some((root) => isSameRoot(root, folder)))
}

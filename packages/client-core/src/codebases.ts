import { CODEBASE_ROOTS_MAX, CODEBASE_ROOTS_MIN, type Codebase, type CodebaseFolderScan, type CodebaseMember, type CodebaseRoot } from '@solus/contracts/codebases'
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

/**
 * Why a folder cannot become a root of a codebase, or cannot stop to be one.
 * `nested`: a root covers the folders inside it, so a folder that is inside a
 * root, or that holds one, on the same host adds nothing. `last-two`: a
 * codebase has two or more folders, so one of the last two cannot be removed.
 */
export type CodebaseRootRefusal = 'duplicate' | 'nested' | 'limit' | 'missing' | 'last-two'

const ROOT_REFUSAL_TEXT = {
  duplicate: 'This folder is already in the codebase.',
  nested: 'This folder is inside a folder of the codebase, or a folder of the codebase is inside it. A folder covers the folders inside it.',
  limit: `A codebase has at most ${CODEBASE_ROOTS_MAX} folders. Remove a folder before you add a new one.`,
  missing: 'This folder does not exist on the host.',
  'last-two': `A codebase has at least ${CODEBASE_ROOTS_MIN} folders. To remove this folder, delete the codebase.`,
} satisfies Record<CodebaseRootRefusal, string>

/** What a person reads when they make a codebase with fewer folders than a codebase has. */
export const NEW_CODEBASE_NEEDS_FOLDERS = `A codebase has at least ${CODEBASE_ROOTS_MIN} folders. Choose a second folder. One folder is a project: a session there gets the repositories inside it with no codebase.`

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
  const onHost = roots.filter((existing) => existing.installationId === root.installationId)
  if (onHost.some((existing) => isInsideHostPath(existing.path, root.path) || isInsideHostPath(root.path, existing.path))) return 'nested'
  if (roots.length >= CODEBASE_ROOTS_MAX) return 'limit'
  return null
}

/** Why a root cannot be removed from these roots, or null when it can. */
export function rootRemovalRefusal(roots: readonly CodebaseRoot[]): CodebaseRootRefusal | null {
  return roots.length <= CODEBASE_ROOTS_MIN ? 'last-two' : null
}

/**
 * True for a record that is a codebase now: not deleted, with two or more
 * roots (docs/plans/codebases.md decision 14). One folder is a project.
 */
export function isLiveCodebase(codebase: Codebase): boolean {
  return codebase.deletedAt === null && codebase.roots.length >= CODEBASE_ROOTS_MIN
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
    .filter(isLiveCodebase)
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
    isLiveCodebase(codebase)
    && codebase.roots.some((root) => root.installationId === installationId && isInsideHostPath(root.path, path)))
}

/**
 * The repositories that a scan found inside its folder. The folder itself is
 * not one of them. A project covers these with no codebase.
 */
export function repositoriesFoundIn(scan: Pick<CodebaseFolderScan, 'members'>): CodebaseMember[] {
  return scan.members.filter((member) => member.discovered && member.state === 'git')
}

/**
 * The members that the start of a run reads on its host: the project folder
 * with the repositories found in it (the scan of the folder), then the
 * members of the codebase of the run that the project does not hold. A
 * project covers its repositories with no codebase (decision 14), and the
 * host plans a new worktree from the same list (`sessionMembers`).
 */
export function startMembers(project: readonly CodebaseMember[], codebase: readonly CodebaseMember[]): CodebaseMember[] {
  const inProject = new Set(project.map((member) => hostPathKey(member.path)))
  return [...project, ...codebase.filter((member) => !inProject.has(hostPathKey(member.path)))]
}

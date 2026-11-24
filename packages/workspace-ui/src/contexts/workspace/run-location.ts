import type { CloneCheckout, CloneStart, FolderCheckout, GitCheckout, Place, RunConfig, RunLocation } from '@solus/contracts/types'
import { sameGitCheckout, worktreeProjectRoot } from '@solus/contracts/types'
import { isChat, NEW_CHAT_DIRECTORY } from '@solus/contracts/chat'

/**
 * The one owner of where a run works (docs/plans/run-location.md).
 *
 * Answers read a run; commands take a `RunLocation` and return the next one.
 * Every function is pure, so a draft and a started session share them, and a
 * caller writes the result back in one assignment: `session.run.location = next`
 * for a tab, `draft.moveTo(next)` for a draft, which reads the new checkout.
 * Code outside this module does not reach into `location.checkout` or
 * `location.project`.
 *
 * The codebase of a run (docs/plans/codebases.md) follows its project home. A
 * command that keeps the project home keeps the codebase: a start choice, a
 * Git answer, a clone, a clone that landed, a change of the host of the tasks,
 * and `openFolder` with `keepProject`. `openFolder` to a different project
 * home clears the codebase, because the new folder is different work; a caller
 * that opens a root of the same codebase passes `keepCodebase`. A new session
 * inherits the codebase of the session it was opened from, but a new chat has
 * none. The repositories chosen for a new worktree are member paths on the run
 * host, so they stay only while the checkout folder and the codebase stay:
 * `openFolder` and `chooseCodebase` set them back to the default.
 *
 * The host gives a run with no codebase the codebase of its folder, or makes
 * one (decision 13). "No codebase" is the person's choice against that
 * (`refuseCodebase`). It follows the codebase: it stays where the codebase
 * stays, and a run that gets a codebase has it no longer.
 *
 * A location saved before the codebase fields existed has neither field. The
 * answers read a field that is not there as null.
 */

type Located = Pick<RunConfig, 'location'>

/** A request for a new worktree as a caller names it. Left out, the repositories are the default set. */
interface NewWorktreeRequest {
  baseBranch: string | null
  repositories?: string[] | null
}

// ── Answers ──────────────────────────────────────────────────────────────

/** The host the agent runs on, or will run on after Send. */
export function runHost(run: Located): string
export function runHost(run: Located | null | undefined): string | undefined
export function runHost(run: Located | null | undefined): string | undefined {
  return run?.location.checkout.serverId
}

/** Where the project lives: the host its tasks are filed on, and the folder the
 *  sidebar groups the session under. The path is `~` while it is not known. */
export function projectHome(run: Located): Place
export function projectHome(run: Located | null | undefined): Place | undefined
export function projectHome(run: Located | null | undefined): Place | undefined {
  return run?.location.project
}

/** The project's folder, or null while the run names none. A chat answers its
 *  own folder; the caller decides whether a chat is a project. */
export function projectRoot(run: Located | null | undefined): string | null {
  const path = run?.location.project.path
  return path && path !== '~' ? path : null
}

/**
 * The folder the run was pointed at, before any worktree inside it. A clone
 * does not exist until Send, so until then this is the checkout it copies: the
 * project home.
 */
export function checkoutPlace(run: Located): Place
export function checkoutPlace(run: Located | null | undefined): Place | undefined
export function checkoutPlace(run: Located | null | undefined): Place | undefined {
  if (!run) return undefined
  const { checkout, project } = run.location
  return checkout.kind === 'folder' ? { serverId: checkout.serverId, path: checkout.path } : project
}

/**
 * Where to read files and Git from now: a selected worktree, else the folder.
 * The host is always the one that holds the path. A clone reads from the
 * checkout it copies, which is where its branch list comes from.
 */
export function workingPlace(run: Located): Place
export function workingPlace(run: Located | null | undefined): Place | undefined
export function workingPlace(run: Located | null | undefined): Place | undefined {
  return run ? workingPlaceOf(run.location) : undefined
}

/** What Git last said about the folder, or null before it answers and for a clone. */
export function checkoutGit(run: Located | null | undefined): GitCheckout | null {
  const checkout = run?.location.checkout
  return checkout?.kind === 'folder' ? checkout.git : null
}

/** The clone Send will make, or null when the run already has a folder. */
export function pendingClone(run: Located | null | undefined): CloneCheckout | null {
  const checkout = run?.location.checkout
  return checkout?.kind === 'clone' ? checkout : null
}

/** The origin branch a clone works from: the one picked for a new worktree,
 *  else the default branch. Null for a worktree that already exists there, for
 *  a branch the target host names on Send, and for a run that is no clone. */
export function cloneBaseBranch(run: Located | null | undefined): string | null {
  const clone = pendingClone(run)
  if (!clone) return null
  if (clone.start.kind === 'new-worktree') return clone.start.baseBranch
  return clone.start.kind === 'default-branch' ? clone.defaultBranch : null
}

/** The agent runs on one host while the project, and its tasks, live on another. */
export function isDispatch(run: Located | null | undefined): boolean {
  return !!run && run.location.checkout.serverId !== run.location.project.serverId
}

/** Whether the run branches a new worktree before the agent starts. An existing
 *  worktree, on this host or a clone's target, needs no creation. */
export function startsWorktree(run: Located | null | undefined): boolean {
  return !!run && locationStartsWorktree(run.location)
}

/** The branch a new worktree forks from, or null when the run starts none or the
 *  host has not named one yet. */
export function worktreeBaseBranch(run: Located | null | undefined): string | null {
  const checkout = run?.location.checkout
  if (!checkout) return null
  if (checkout.kind === 'folder') return checkout.newWorktree?.baseBranch ?? null
  return checkout.start.kind === 'new-worktree' ? checkout.start.baseBranch : null
}

/** The id of the codebase the run starts with, or null for a run with one working directory. */
export function codebaseOf(run: Located | null | undefined): string | null {
  return run?.location.codebaseId ?? null
}

/** The person chose "No codebase": the host gives the session of this run none. */
export function refusesCodebase(run: Located | null | undefined): boolean {
  return run?.location.noCodebase === true
}

/** The member paths of the codebase that get a worktree when the run starts a
 *  new worktree in a folder. Null is the default set, which the host chooses;
 *  it is also the answer for a run that starts no new worktree and for a clone. */
export function worktreeRepositories(run: Located | null | undefined): string[] | null {
  const checkout = run?.location.checkout
  return checkout?.kind === 'folder' ? checkout.newWorktree?.repositories ?? null : null
}

export function samePlace(a: Place, b: Place): boolean {
  return a.serverId === b.serverId && a.path === b.path
}

// ── Building a location ──────────────────────────────────────────────────

/**
 * A run that works in `place`. Without a project of its own the folder is its
 * own project, named by Git's root when Git has answered and by the folder (a
 * Solus worktree's root) when it has not.
 */
export function folderLocation(
  place: Place,
  opts: { git?: GitCheckout | null; newWorktree?: NewWorktreeRequest | null; project?: Place } & Partial<CodebaseChoice> = {},
): RunLocation {
  const git = opts.git ?? null
  const newWorktree = opts.newWorktree ? { baseBranch: opts.newWorktree.baseBranch, repositories: opts.newWorktree.repositories ?? null } : null
  return {
    checkout: { kind: 'folder', serverId: place.serverId, path: place.path, git, newWorktree },
    project: opts.project ?? projectOf(place, git),
    ...(opts.noCodebase ? { codebaseId: null, noCodebase: true as const } : { codebaseId: opts.codebaseId ?? null }),
  }
}

/**
 * The location a new session takes from the one it was opened from.
 *
 * Isolation is a decision about one piece of work, so the new session starts in
 * its checkout and asks for a worktree itself. A chat's folder is its own: the
 * next session from it is a new chat. A clone is a choice for one Send, so the
 * new session goes back to the checkout it would have copied. A fresh task
 * starts at the project root rather than in a worktree the user moved on from.
 */
export function inheritedLocation(location: RunLocation, opts: { freshTask?: boolean } = {}): RunLocation {
  const { checkout, project } = location
  const codebase = codebaseChoiceOf(location)
  if (checkout.kind === 'clone') return folderLocation(project, { project, ...codebase })
  if (isChat(checkout.path)) return folderLocation({ serverId: checkout.serverId, path: NEW_CHAT_DIRECTORY })
  if (opts.freshTask) {
    const root = checkout.git?.repoRoot ?? (checkout.path !== '~' ? checkout.path : null)
    if (root) return folderLocation({ serverId: checkout.serverId, path: root }, { project, ...codebase })
    return folderLocation({ serverId: checkout.serverId, path: checkout.path }, { project, ...codebase })
  }
  return folderLocation({ serverId: checkout.serverId, path: checkout.path }, { git: checkout.git ? { ...checkout.git } : null, project, ...codebase })
}

/** The same location with each host id passed through `remap`: a restored run
 *  names hosts by an id that may have changed since it was saved. */
export function remapHosts(location: RunLocation, remap: (serverId: string) => string): RunLocation {
  return {
    checkout: { ...location.checkout, serverId: remap(location.checkout.serverId) },
    project: { ...location.project, serverId: remap(location.project.serverId) },
    ...codebaseChoiceOf(location),
  }
}

// ── Commands ─────────────────────────────────────────────────────────────

/**
 * Work in a folder that exists on `place.serverId`, on any host. The agent runs
 * where the folder is, so the path and its host are written together; nothing
 * waits for Send except connecting, which Send reads from the host itself.
 *
 * The folder becomes the project, unless `keepProject` says the project stays
 * home (a dispatch into a folder the person picked over there). A request for a
 * new worktree survives with its base branch and its repositories dropped:
 * wanting isolation is a preference about the work, and the base branch and the
 * repositories named things in the old folder.
 *
 * The codebase stays when the project home stays (`keepProject`, or the folder
 * is the project home the run has) and when `keepCodebase` says the folder is
 * a root of the same codebase. A different project home has no codebase.
 */
export function openFolder(
  location: RunLocation,
  place: Place,
  opts: { git?: GitCheckout | null; keepProject?: boolean; keepCodebase?: boolean } = {},
): RunLocation {
  const next = folderLocation(place, {
    git: opts.git,
    newWorktree: locationStartsWorktree(location) ? { baseBranch: null } : null,
    project: opts.keepProject ? location.project : undefined,
  })
  const keepsCodebase = opts.keepCodebase || samePlace(next.project, location.project)
  return keepsCodebase ? { ...next, ...codebaseChoiceOf(location) } : next
}

/**
 * Send this run to `serverId`, which first gets a clone of `repoKey`. The
 * project and its tasks stay home. A run in its checkout works on the default
 * branch over there; a run that asked for a worktree keeps asking, with the base
 * branch for the target host to name.
 */
export function dispatchTo(location: RunLocation, serverId: string, repoKey: string): RunLocation {
  const { checkout } = location
  const defaultBranch = checkout.kind === 'folder' ? checkout.git?.targetBranch ?? null : checkout.defaultBranch
  return {
    checkout: {
      kind: 'clone',
      serverId,
      repoKey,
      defaultBranch,
      start: locationStartsWorktree(location) ? { kind: 'new-worktree', baseBranch: null } : { kind: 'default-branch' },
    },
    project: location.project,
    ...codebaseChoiceOf(location),
  }
}

/** How the agent begins in its checkout. */
export type StartChoice =
  /** In the checkout itself, on its current branch (a clone: the default branch). */
  | { kind: 'checkout' }
  /** In a new worktree, from `baseBranch` or from the checkout's base. */
  | { kind: 'new-worktree'; baseBranch?: string }
  /** In a worktree that already exists. `git` is the host's answer for it, when read. */
  | { kind: 'worktree'; path: string; branch: string; targetBranch?: string | null; git?: GitCheckout | null }
  /** The folder's checkout moved to another branch on disk; `git` is the host's answer. */
  | { kind: 'branch'; git: GitCheckout }

/**
 * Choose where the agent begins. The checkout keeps its host and its project,
 * so branch and worktree choices never move a dispatch's tasks.
 */
export function chooseStart(location: RunLocation, choice: StartChoice): RunLocation {
  const { checkout } = location
  return checkout.kind === 'clone'
    ? chooseCloneStart(location, checkout, choice)
    : { ...location, checkout: chooseFolderStart(checkout, choice) ?? checkout }
}

function chooseCloneStart(location: RunLocation, checkout: CloneCheckout, choice: StartChoice): RunLocation {
  // A clone's branch is chosen over there on Send, so a switch on disk here
  // does not apply to it.
  if (choice.kind === 'branch') return location
  const start: CloneStart = choice.kind === 'checkout'
    ? { kind: 'default-branch' }
    : choice.kind === 'worktree'
      ? { kind: 'worktree', path: choice.path, branch: choice.branch }
      : { kind: 'new-worktree', baseBranch: choice.baseBranch ?? null }
  return { ...location, checkout: { ...checkout, start } }
}

/** The folder after `choice`, or null when there is nothing to change. */
function chooseFolderStart(checkout: FolderCheckout, choice: StartChoice): FolderCheckout | null {
  const root = checkout.git?.repoRoot ?? worktreeProjectRoot(checkout.git?.worktreePath ?? checkout.path)
  switch (choice.kind) {
    case 'checkout':
      return { ...checkout, newWorktree: null }
    case 'new-worktree':
      return withNewWorktree(checkout, root, choice.baseBranch)
    case 'worktree':
      return {
        ...checkout,
        path: choice.git?.repoRoot ?? root,
        git: choice.git ?? {
          repoRoot: root,
          worktreePath: choice.path,
          branch: choice.branch,
          targetBranch: checkout.git?.targetBranch ?? choice.targetBranch ?? choice.branch,
        },
        newWorktree: null,
      }
    case 'branch':
      return {
        ...checkout,
        path: choice.git.repoRoot ?? root,
        git: choice.git,
        newWorktree: checkout.newWorktree ? { baseBranch: null, repositories: checkout.newWorktree.repositories ?? null } : null,
      }
  }
}

/**
 * Start with the codebase `codebaseId`, or with none. The checkout and the
 * project home stay. The repositories chosen for a new worktree were members
 * of the codebase the run had, so a different codebase sets them back to the
 * default.
 */
export function chooseCodebase(location: RunLocation, codebaseId: string | null): RunLocation {
  if ((location.codebaseId ?? null) === codebaseId) return location
  const { checkout } = location
  const reset = checkout.kind === 'folder' && checkout.newWorktree
    ? { ...checkout, newWorktree: { baseBranch: checkout.newWorktree.baseBranch, repositories: null } }
    : checkout
  // A run that has a codebase does not refuse one.
  const { noCodebase: _refused, ...kept } = location
  return { ...(codebaseId ? kept : location), checkout: reset, codebaseId }
}

/**
 * The person chose "No codebase" (`refuses` true), or took that choice back.
 * The host gives a session with no codebase the codebase of its folder, or
 * makes one (docs/plans/codebases.md decision 13). A run that refuses gets
 * none. The run has no codebase after each of the two.
 */
export function refuseCodebase(location: RunLocation, refuses = true): RunLocation {
  const cleared = chooseCodebase(location, null)
  if ((cleared.noCodebase === true) === refuses) return cleared
  const { noCodebase: _refused, ...allowed } = cleared
  return refuses ? { ...cleared, noCodebase: true } : allowed
}

/**
 * Choose the members of the codebase that get a worktree: their paths on the
 * run host, or null for the default set. The choice is part of a request for a
 * new worktree in a folder, so a run that starts none, and a clone, do not
 * change. A clone gets its worktrees on a host where nothing can be read yet.
 */
export function chooseWorktreeRepositories(location: RunLocation, paths: string[] | null): RunLocation {
  const { checkout } = location
  if (checkout.kind !== 'folder' || !checkout.newWorktree) return location
  const current = checkout.newWorktree.repositories ?? null
  if (current === paths || (current && paths && current.length === paths.length && current.every((path, index) => path === paths[index]))) return location
  return { ...location, checkout: { ...checkout, newWorktree: { baseBranch: checkout.newWorktree.baseBranch, repositories: paths ? [...paths] : null } } }
}

/**
 * Take Git's answer about `place`, read on the host that holds it. An answer
 * for a place the run has left, on another host or at another path, is dropped:
 * the read began before the run moved. `newWorktree` is the request as the
 * reader resolved it, with the base branch the host named; omitted, the run
 * keeps the request it has. The repositories of the request are the run's own
 * choice, so a Git answer never changes them. A folder that is not a
 * repository has no branch for the host to name: the base branch that the
 * person named for it stays.
 */
export function adoptGit(
  location: RunLocation,
  place: Place,
  git: GitCheckout | null,
  request?: { baseBranch: string | null } | null,
): RunLocation {
  const { checkout, project } = location
  if (checkout.kind !== 'folder' || !samePlace(place, workingPlaceOf(location))) return location
  const newWorktree = request === undefined
    ? checkout.newWorktree
    : request && {
        baseBranch: request.baseBranch ?? (git ? null : checkout.newWorktree?.baseBranch ?? null),
        repositories: checkout.newWorktree?.repositories ?? null,
      }
  // A folder that is its own project is named by Git's root once Git answers.
  // A dispatch's project is the home checkout, which this answer does not describe.
  const ownsProject = project.serverId === checkout.serverId
  const nextProject = ownsProject && git?.repoRoot ? { serverId: project.serverId, path: git.repoRoot } : project
  // An answer that changes nothing keeps the same location. Callers assign the
  // result to the run, and a new object wakes every effect that reads it.
  if (sameGitCheckout(checkout.git, git)
    && checkout.newWorktree?.baseBranch === newWorktree?.baseBranch
    && !checkout.newWorktree === !newWorktree
    && samePlace(nextProject, project)) return location
  return {
    ...location,
    checkout: { ...checkout, git, newWorktree },
    project: nextProject,
  }
}

/**
 * Work in the folder of a task folder that stands in for a folder with no
 * repository (docs/plans/codebases.md §7). Such a session has no checkout, so
 * no Git answer moves its run. Files and Git are read in the stand-in, and the
 * project home stays the folder that it stands in for, with its codebase. The
 * task folder is the new worktree that the run asked for, so the request ends.
 */
export function workInStandIn(location: RunLocation, standInPath: string): RunLocation {
  const { checkout } = location
  if (checkout.kind !== 'folder') return location
  const moved = openFolder(location, { serverId: checkout.serverId, path: standInPath }, { keepProject: true })
  return chooseStart(moved, { kind: 'checkout' })
}

/** File the run's tasks on `serverId`, its folder unchanged: a task in the
 *  cloud workspace service runs on an execution host. */
export function fileTasksOn(location: RunLocation, serverId: string): RunLocation {
  return { ...location, project: { ...location.project, serverId } }
}

/**
 * Send made the clone at `path` on the run host. The run becomes a folder
 * there; the project stays home, which is what makes it a dispatch. A chosen
 * branch is carried as the folder's provisional checkout until that host's own
 * Git read answers.
 */
export function landClone(location: RunLocation, path: string): RunLocation {
  const { checkout, project } = location
  if (checkout.kind !== 'clone') return location
  const { start } = checkout
  const branch = start.kind === 'worktree'
    ? start.branch
    : start.kind === 'new-worktree'
      ? start.baseBranch
      : checkout.defaultBranch
  const folder: FolderCheckout = branch
    ? {
        kind: 'folder',
        serverId: checkout.serverId,
        path,
        git: { repoRoot: worktreeProjectRoot(path), branch, targetBranch: branch, worktreePath: path },
        newWorktree: null,
      }
    : {
        kind: 'folder',
        serverId: checkout.serverId,
        path,
        git: null,
        newWorktree: start.kind === 'new-worktree' ? { baseBranch: null, repositories: null } : null,
      }
  return { ...location, checkout: folder, project }
}

// ── Internals ────────────────────────────────────────────────────────────

/** The codebase fields of a location: the codebase, and the choice of the person to have none. */
type CodebaseChoice = Pick<RunLocation, 'codebaseId' | 'noCodebase'>

function codebaseChoiceOf(location: RunLocation): CodebaseChoice {
  return location.noCodebase ? { codebaseId: null, noCodebase: true } : { codebaseId: location.codebaseId ?? null }
}

/** Ask for a new worktree. One is made from the project root and its target
 *  branch, so a run inside a selected worktree moves back to the root first;
 *  with no branch to fork from there is nothing to change. */
function withNewWorktree(checkout: FolderCheckout, root: string, baseBranch: string | undefined): FolderCheckout | null {
  const repositories = checkout.newWorktree?.repositories ?? null
  if (!checkout.git?.worktreePath) {
    return { ...checkout, newWorktree: { baseBranch: baseBranch ?? checkout.git?.targetBranch ?? null, repositories } }
  }
  const base = baseBranch ?? checkout.git.targetBranch
  if (!base) return null
  return {
    ...checkout,
    path: root,
    git: { repoRoot: root, branch: base, targetBranch: base },
    newWorktree: { baseBranch: base, repositories },
  }
}

function workingPlaceOf(location: RunLocation): Place {
  const { checkout, project } = location
  if (checkout.kind === 'clone') return project
  return { serverId: checkout.serverId, path: checkout.git?.worktreePath ?? checkout.path }
}

function locationStartsWorktree(location: RunLocation): boolean {
  const { checkout } = location
  return checkout.kind === 'folder' ? !!checkout.newWorktree : checkout.start.kind === 'new-worktree'
}

function projectOf(place: Place, git: GitCheckout | null): Place {
  return { serverId: place.serverId, path: git?.repoRoot ?? worktreeProjectRoot(place.path) }
}

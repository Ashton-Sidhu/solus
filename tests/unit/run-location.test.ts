import { describe, expect, test } from 'bun:test'
import type { GitCheckout, RunLocation } from '@solus/contracts/types'
import { NEW_CHAT_DIRECTORY } from '@solus/contracts/chat'
import {
  adoptGit,
  checkoutGit,
  checkoutPlace,
  chooseCodebase,
  chooseStart,
  chooseWorktreeRepositories,
  cloneBaseBranch,
  codebaseOf,
  dispatchTo,
  folderLocation,
  inheritedLocation,
  isDispatch,
  landClone,
  openFolder,
  pendingClone,
  projectHome,
  projectRoot,
  remapHosts,
  runHost,
  startsWorktree,
  workingPlace,
  worktreeBaseBranch,
  worktreeRepositories,
} from '@solus/workspace-ui/contexts/workspace/run-location'

const main: GitCheckout = { repoRoot: '/Users/me/solus', branch: 'main', targetBranch: 'main' }
const local = (git: GitCheckout | null = main): RunLocation =>
  folderLocation({ serverId: 'mac', path: '/Users/me/solus' }, { git })
const run = (location: RunLocation) => ({ location })

describe('opening a folder on another host', () => {
  test('the folder and its host move together, so Git is read where the folder is', () => {
    // WHY: the bug this module exists for. A pending choice left the run on
    // this Mac with a path that exists only on omarchy, so the branch chip
    // asked this Mac about omarchy's folder, found no repository, and hid.
    const next = run(openFolder(local(), { serverId: 'omarchy', path: '/home/me/solus' }))
    expect(runHost(next)).toBe('omarchy')
    expect(workingPlace(next)).toEqual({ serverId: 'omarchy', path: '/home/me/solus' })
    expect(isDispatch(next)).toBe(false)
  })

  test('the old checkout does not travel: its Git answer described another folder', () => {
    const next = openFolder(local(), { serverId: 'omarchy', path: '/home/me/solus' })
    expect(checkoutPlace(run(next))).toEqual({ serverId: 'omarchy', path: '/home/me/solus' })
    expect(next.checkout.kind === 'folder' && next.checkout.git).toBeNull()
  })

  test('a request for a new worktree survives, with the old base branch dropped', () => {
    // WHY: wanting isolation is about the work; the base branch named a branch
    // in the folder the run left.
    const isolated = chooseStart(local(), { kind: 'new-worktree' })
    const next = run(openFolder(isolated, { serverId: 'omarchy', path: '/home/me/solus' }))
    expect(startsWorktree(next)).toBe(true)
    expect(next.location.checkout.kind === 'folder' && next.location.checkout.newWorktree).toEqual({ baseBranch: null, repositories: null })
  })

  test('a folder picked for a dispatch keeps the project, and its tasks, home', () => {
    const next = run(openFolder(local(), { serverId: 'omarchy', path: '/home/me/solus' }, { keepProject: true }))
    expect(isDispatch(next)).toBe(true)
    expect(projectHome(next)).toEqual({ serverId: 'mac', path: '/Users/me/solus' })
  })
})

describe('a clone', () => {
  test('runs on its host but reads Git from the checkout it copies until Send', () => {
    // WHY: nothing exists on the target before Send, so its branch list comes
    // from the home checkout, while the agent and the Run on chip name the target.
    const next = run(dispatchTo(local(), 'omarchy', 'github.com/me/solus'))
    expect(runHost(next)).toBe('omarchy')
    expect(workingPlace(next)).toEqual({ serverId: 'mac', path: '/Users/me/solus' })
    expect(isDispatch(next)).toBe(true)
    expect(cloneBaseBranch(next)).toBe('main')
  })

  test('lands as a folder on its host with the project still home', () => {
    const cloned = dispatchTo(local(), 'omarchy', 'github.com/me/solus')
    const landed = run(landClone(cloned, '/home/me/projects/solus'))
    expect(pendingClone(landed)).toBeNull()
    expect(checkoutPlace(landed)).toEqual({ serverId: 'omarchy', path: '/home/me/projects/solus' })
    expect(projectHome(landed)).toEqual({ serverId: 'mac', path: '/Users/me/solus' })
  })

  test('an existing target worktree lands as that exact worktree', () => {
    const picked = chooseStart(dispatchTo(local(), 'omarchy', 'github.com/me/solus'), {
      kind: 'worktree',
      path: '/home/me/wt/fix',
      branch: 'fix',
    })
    expect(startsWorktree(run(picked))).toBe(false)
    const landed = run(landClone(picked, '/home/me/wt/fix'))
    expect(workingPlace(landed)).toEqual({ serverId: 'omarchy', path: '/home/me/wt/fix' })
  })

  test('start choices stay clone choices: a branch switch on disk does not apply', () => {
    const cloned = dispatchTo(local(), 'omarchy', 'github.com/me/solus')
    expect(chooseStart(cloned, { kind: 'branch', git: main })).toBe(cloned)
    const isolated = chooseStart(cloned, { kind: 'new-worktree', baseBranch: 'release' })
    expect(startsWorktree(run(isolated))).toBe(true)
    expect(cloneBaseBranch(run(isolated))).toBe('release')
  })
})

describe('a Git answer', () => {
  test('lands on the folder it describes', () => {
    const next = adoptGit(local(null), { serverId: 'mac', path: '/Users/me/solus' }, main, null)
    expect(next.checkout.kind === 'folder' && next.checkout.git).toEqual(main)
  })

  test('for the same path on another host is dropped', () => {
    // WHY: a read that began before the run moved hosts describes a folder the
    // run has left, even when the two hosts use the same path.
    const moved = openFolder(local(), { serverId: 'omarchy', path: '/Users/me/solus' })
    expect(adoptGit(moved, { serverId: 'mac', path: '/Users/me/solus' }, main, null)).toBe(moved)
  })

  test('that changes nothing keeps the same location', () => {
    // WHY: callers assign the result to the run, and a new object re-runs every
    // effect that reads it. A folder outside Git answered `null` on each read,
    // so the draft re-read Git and plugin commands in a loop that never settled.
    const place = { serverId: 'mac', path: '/Users/me/solus' }
    const outsideGit = local(null)
    expect(adoptGit(outsideGit, place, null, null)).toBe(outsideGit)
    const onMain = local()
    expect(adoptGit(onMain, place, { ...main }, null)).toBe(onMain)
    expect(adoptGit(onMain, place, { ...main, branch: 'feature' }, null)).not.toBe(onMain)
    expect(adoptGit(onMain, place, { ...main }, { baseBranch: 'main' })).not.toBe(onMain)
  })

  test('names the project by Git root, but never a dispatched run’s home', () => {
    const subfolder = folderLocation({ serverId: 'mac', path: '/Users/me/solus/app' })
    expect(projectRoot(run(adoptGit(subfolder, { serverId: 'mac', path: '/Users/me/solus/app' }, main)))).toBe('/Users/me/solus')
    const dispatched = openFolder(local(), { serverId: 'omarchy', path: '/home/me/solus' }, { keepProject: true })
    const answered = adoptGit(dispatched, { serverId: 'omarchy', path: '/home/me/solus' }, { ...main, repoRoot: '/home/me/solus' })
    expect(projectHome(run(answered))).toEqual({ serverId: 'mac', path: '/Users/me/solus' })
  })
})

describe('a new session from another', () => {
  test('never becomes a dispatch unless its source was one', () => {
    expect(isDispatch(run(inheritedLocation(local())))).toBe(false)
    const dispatched = openFolder(local(), { serverId: 'omarchy', path: '/home/me/solus' }, { keepProject: true })
    expect(isDispatch(run(inheritedLocation(dispatched)))).toBe(true)
  })

  test('starts in its checkout, and a clone goes back to the checkout it copies', () => {
    const isolated = chooseStart(local(), { kind: 'new-worktree' })
    expect(startsWorktree(run(inheritedLocation(isolated)))).toBe(false)
    const cloned = dispatchTo(local(), 'omarchy', 'github.com/me/solus')
    expect(checkoutPlace(run(inheritedLocation(cloned)))).toEqual({ serverId: 'mac', path: '/Users/me/solus' })
  })

  test('from a chat is a new chat', () => {
    const chat = folderLocation({ serverId: 'mac', path: '/Users/me/.solus/solus-chats/abc' })
    expect(checkoutPlace(run(inheritedLocation(chat))).path).toBe(NEW_CHAT_DIRECTORY)
  })
})

describe('choosing where to start in a folder', () => {
  test('a selected worktree keeps the project root and asks for no new worktree', () => {
    const next = run(chooseStart(local(), { kind: 'worktree', path: '/tmp/wt-second', branch: 'second' }))
    expect(checkoutPlace(next).path).toBe('/Users/me/solus')
    expect(workingPlace(next).path).toBe('/tmp/wt-second')
    expect(startsWorktree(next)).toBe(false)
  })

  test('a new worktree from inside a selected one starts back at the project root', () => {
    const inWorktree = chooseStart(local(), { kind: 'worktree', path: '/tmp/wt-second', branch: 'second' })
    const next = run(chooseStart(inWorktree, { kind: 'new-worktree' }))
    expect(workingPlace(next).path).toBe('/Users/me/solus')
    expect(startsWorktree(next)).toBe(true)
  })

  test('a branch the host found in another worktree moves the run there, not onto the folder', () => {
    // WHY: from a stale list, the host answers a branch switch with the
    // worktree that already has the branch and leaves the folder as it was.
    // The desktop picker applies that answer as a branch choice, so the run
    // must work where the answer points, or the agent starts on the old branch.
    const inOther = run(chooseStart(local(), { kind: 'branch', git: { repoRoot: '/Users/me/solus', worktreePath: '/tmp/wt-fix', branch: 'fix', targetBranch: 'main' } }))
    expect(workingPlace(inOther).path).toBe('/tmp/wt-fix')
    expect(checkoutGit(inOther)?.branch).toBe('fix')
    // The main checkout has the branch: the answer names the repository root.
    const fromWorktree = chooseStart(local(), { kind: 'worktree', path: '/tmp/wt-fix', branch: 'fix' })
    const inMain = run(chooseStart(fromWorktree, { kind: 'branch', git: main }))
    expect(workingPlace(inMain).path).toBe('/Users/me/solus')
    expect(checkoutGit(inMain)?.branch).toBe('main')
  })
})

test('a restored run renames both of its hosts', () => {
  // WHY: a host paired again gets a new registry id; a run that renamed only
  // its run host would turn into a dispatch to a host that no longer exists.
  const dispatched = openFolder(local(), { serverId: 'omarchy', path: '/home/me/solus' }, { keepProject: true })
  const restored = run(remapHosts(dispatched, (id) => `${id}-2`))
  expect(runHost(restored)).toBe('omarchy-2')
  expect(projectHome(restored).serverId).toBe('mac-2')
})

// docs/plans/codebases.md §4: a run can start with a codebase, and a new
// worktree session can isolate some of its repositories. The codebase follows
// the project home of the run.
describe('the codebase of a run', () => {
  const withCodebase = () => chooseCodebase(local(), 'codebase-shop')

  test('a run has no codebase until one is chosen, and the choice changes nothing else', () => {
    expect(codebaseOf(run(local()))).toBeNull()
    expect(codebaseOf(null)).toBeNull()
    const chosen = run(withCodebase())
    expect(codebaseOf(chosen)).toBe('codebase-shop')
    expect(workingPlace(chosen)).toEqual(workingPlace(run(local())))
    expect(projectHome(chosen)).toEqual(projectHome(run(local())))
    expect(codebaseOf(run(chooseCodebase(withCodebase(), null)))).toBeNull()
  })

  test('the same choice again keeps the same location', () => {
    // WHY: a caller assigns the result to the run, and a new object wakes each effect that reads it.
    const chosen = withCodebase()
    expect(chooseCodebase(chosen, 'codebase-shop')).toBe(chosen)
  })

  test('a different project home has no codebase', () => {
    // WHY: the codebase names the work of the folder the run left. A session
    // in a different project must not get the folders of that work.
    const moved = run(openFolder(withCodebase(), { serverId: 'mac', path: '/Users/me/other' }))
    expect(codebaseOf(moved)).toBeNull()
  })

  test('a root of the same codebase keeps it when the caller says so', () => {
    const moved = run(openFolder(withCodebase(), { serverId: 'mac', path: '/Users/me/shop-web' }, { keepCodebase: true }))
    expect(codebaseOf(moved)).toBe('codebase-shop')
    expect(workingPlace(moved).path).toBe('/Users/me/shop-web')
  })

  test('a folder on a different host for the same project keeps the codebase', () => {
    const dispatched = run(openFolder(withCodebase(), { serverId: 'omarchy', path: '/home/me/solus' }, { keepProject: true }))
    expect(codebaseOf(dispatched)).toBe('codebase-shop')
  })

  test('start choices, Git answers, a clone, and its landing keep the codebase', () => {
    const chosen = withCodebase()
    expect(codebaseOf(run(chooseStart(chosen, { kind: 'new-worktree' })))).toBe('codebase-shop')
    expect(codebaseOf(run(chooseStart(chosen, { kind: 'worktree', path: '/tmp/wt-fix', branch: 'fix' })))).toBe('codebase-shop')
    const place = workingPlace(run(chosen))
    expect(codebaseOf(run(adoptGit(chosen, place, { ...main, branch: 'next' })))).toBe('codebase-shop')
    const clone = dispatchTo(chosen, 'omarchy', 'github.com/acme/solus')
    expect(codebaseOf(run(clone))).toBe('codebase-shop')
    expect(codebaseOf(run(landClone(clone, '/home/me/clones/solus')))).toBe('codebase-shop')
    expect(codebaseOf(run(remapHosts(chosen, (id) => `${id}-2`)))).toBe('codebase-shop')
  })

  test('a new session inherits the codebase, but a new chat has none', () => {
    // Decision 5: a session records the codebase it started with, and the next session of the same work starts with it.
    expect(codebaseOf(run(inheritedLocation(withCodebase())))).toBe('codebase-shop')
    expect(codebaseOf(run(inheritedLocation(withCodebase(), { freshTask: true })))).toBe('codebase-shop')
    const chat = chooseCodebase(folderLocation({ serverId: 'mac', path: '/Users/me/.solus/solus-chats/abc' }), 'codebase-shop')
    expect(codebaseOf(run(inheritedLocation(chat)))).toBeNull()
  })

  test('a location saved before the codebase fields existed reads as no codebase and the default repositories', () => {
    // WHY: Solus drops no saved draft for this change; the answers read a field that is not there as null.
    const saved = JSON.parse(JSON.stringify(chooseStart(local(), { kind: 'new-worktree' })))
    delete saved.codebaseId
    delete saved.checkout.newWorktree.repositories
    expect(codebaseOf(run(saved))).toBeNull()
    expect(worktreeRepositories(run(saved))).toBeNull()
    expect(codebaseOf(run(remapHosts(saved, (id) => id)))).toBeNull()
  })
})

describe('the repositories of a new worktree', () => {
  const isolated = () => chooseStart(chooseCodebase(local(), 'codebase-shop'), { kind: 'new-worktree' })
  const chosen = () => chooseWorktreeRepositories(isolated(), ['/Users/me/shop/api', '/Users/me/shop/web'])

  test('the default set is null, and a choice is kept with the base branch', () => {
    expect(worktreeRepositories(run(isolated()))).toBeNull()
    expect(worktreeRepositories(run(chosen()))).toEqual(['/Users/me/shop/api', '/Users/me/shop/web'])
    expect(worktreeBaseBranch(run(chosen()))).toBe('main')
    expect(worktreeRepositories(run(chooseWorktreeRepositories(chosen(), null)))).toBeNull()
  })

  test('a run that starts no new worktree has no repositories to choose', () => {
    const inFolder = chooseCodebase(local(), 'codebase-shop')
    expect(chooseWorktreeRepositories(inFolder, ['/Users/me/shop/api'])).toBe(inFolder)
    expect(worktreeRepositories(run(inFolder))).toBeNull()
    // A clone gets its worktrees on a host where nothing can be read before Send.
    const clone = dispatchTo(isolated(), 'omarchy', 'github.com/acme/solus')
    expect(chooseWorktreeRepositories(clone, ['/Users/me/shop/api'])).toBe(clone)
    expect(worktreeRepositories(run(clone))).toBeNull()
  })

  test('the same choice again keeps the same location', () => {
    const location = chosen()
    expect(chooseWorktreeRepositories(location, ['/Users/me/shop/api', '/Users/me/shop/web'])).toBe(location)
  })

  test('a Git answer and a different base branch keep the choice', () => {
    // WHY: Git answers after the person chose. An answer that set the choice back to the default would isolate the wrong repositories.
    const location = chosen()
    const answered = adoptGit(location, workingPlace(run(location)), { ...main, branch: 'next' }, { baseBranch: 'develop' })
    expect(worktreeRepositories(run(answered))).toEqual(['/Users/me/shop/api', '/Users/me/shop/web'])
    expect(worktreeBaseBranch(run(answered))).toBe('develop')
    const rebased = chooseStart(location, { kind: 'new-worktree', baseBranch: 'release' })
    expect(worktreeRepositories(run(rebased))).toEqual(['/Users/me/shop/api', '/Users/me/shop/web'])
  })

  test('work in the checkout itself drops the choice with the request', () => {
    expect(worktreeRepositories(run(chooseStart(chosen(), { kind: 'checkout' })))).toBeNull()
  })

  test('a different folder or a different codebase sets the choice back to the default', () => {
    // WHY: the paths name members of the old codebase on the old run host.
    const moved = run(openFolder(chosen(), { serverId: 'omarchy', path: '/home/me/solus' }, { keepProject: true }))
    expect(startsWorktree(moved)).toBe(true)
    expect(worktreeRepositories(moved)).toBeNull()
    const other = run(chooseCodebase(chosen(), 'codebase-tools'))
    expect(startsWorktree(other)).toBe(true)
    expect(worktreeRepositories(other)).toBeNull()
  })
})

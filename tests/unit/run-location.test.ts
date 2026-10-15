import { describe, expect, test } from 'bun:test'
import type { GitCheckout, RunLocation } from '@solus/contracts/types'
import { NEW_CHAT_DIRECTORY } from '@solus/contracts/chat'
import {
  adoptGit,
  checkoutPlace,
  chooseStart,
  cloneBaseBranch,
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
    expect(next.location.checkout.kind === 'folder' && next.location.checkout.newWorktree).toEqual({ baseBranch: null })
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
    const landed = run(landClone(cloned, '/home/me/projects/solus-remote/solus'))
    expect(pendingClone(landed)).toBeNull()
    expect(checkoutPlace(landed)).toEqual({ serverId: 'omarchy', path: '/home/me/projects/solus-remote/solus' })
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
})

test('a restored run renames both of its hosts', () => {
  // WHY: a host paired again gets a new registry id; a run that renamed only
  // its run host would turn into a dispatch to a host that no longer exists.
  const dispatched = openFolder(local(), { serverId: 'omarchy', path: '/home/me/solus' }, { keepProject: true })
  const restored = run(remapHosts(dispatched, (id) => `${id}-2`))
  expect(runHost(restored)).toBe('omarchy-2')
  expect(projectHome(restored).serverId).toBe('mac-2')
})

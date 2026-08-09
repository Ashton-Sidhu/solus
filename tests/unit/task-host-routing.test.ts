import { beforeEach, describe, expect, test } from 'bun:test'
import { runTarget } from '../../src/renderer/components/servers/lib/run-target'
import { isDispatch, startsWorktree, withCheckout, withHost, withProjectHost, withWorktreeToggled } from '../../src/renderer/contexts/workspace/run-config'
import type { RunConfig } from '../../src/shared/types'

function runOn(serverId: string, taskServerId: string, overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    workingDirectory: '/srv/projects/solus',
    gitContext: null,
    worktree: null,
    modelConfig: { modelId: null, reasoningEffort: 'high', contextWindow: null, fastMode: false },
    permissionMode: 'auto',
    provider: null,
    serverId,
    taskServerId,
    projectGroupPath: null,
    sessionSkills: [],
    pendingHostDispatch: null,
    ...overrides,
  }
}

let local: RunConfig

beforeEach(() => {
  local = runOn('local', 'local', { workingDirectory: '/home/dev/solus' })
})

describe('which host owns a run’s tasks', () => {
  test('dispatching moves where it runs, never where it files', () => {
    // WHY: dispatch hands the target host a *clone* (ADR-0002). The project was
    // and remains this machine's, so a task minted on the far side would land in
    // a database nobody reads, on a machine borrowed only to run an agent.
    const dispatched = withHost(local, 'studio', { path: '/srv/projects/solus' })

    expect(dispatched.serverId).toBe('studio')
    expect(dispatched.taskServerId).toBe('local')
    expect(isDispatch(dispatched)).toBe(true)
  })

  test('opening a project on a host moves both, so it is not a dispatch', () => {
    // WHY: this is use case two. The folder is that host's project outright, so
    // its tasks belong there and none of the dispatch machinery applies.
    const opened = withProjectHost(local, 'studio', { path: '/srv/projects/solus' })

    expect(opened.serverId).toBe('studio')
    expect(opened.taskServerId).toBe('studio')
    expect(isDispatch(opened)).toBe(false)
  })

  test('only a dispatch forces its own worktree', () => {
    // WHY: a dispatched session's base checkout sits on a machine nobody is
    // watching, so a collision there has no one to untangle it. A project that
    // merely lives on another host is no different from a local one.
    expect(startsWorktree(withHost(local, 'studio', { path: '/p' }))).toBe(true)
    expect(startsWorktree(withProjectHost(local, 'studio', { path: '/p' }))).toBe(false)
    // The user's own choice still stands on both.
    expect(startsWorktree({ ...local, worktree: { baseBranch: null } })).toBe(true)
  })

  test('a run that never left keeps both ids together', () => {
    expect(isDispatch(local)).toBe(false)
    expect(startsWorktree(local)).toBe(false)
  })

  test('a dispatch continuing inside a session worktree does not branch another one', () => {
    // WHY: the forced-worktree rule protects the target's *base checkout*, which
    // sits on a machine nobody is watching. A draft opened from a dispatched
    // session points into that session's worktree — watched from right here —
    // and the same gesture on a local session continues in place. Forcing a
    // second worktree would break that parity (docs/plans/dispatch-parity.md).
    const continuing = runOn('studio', 'local', {
      gitContext: {
        repoRoot: '/srv/projects/solus',
        branch: 'feat-x',
        targetBranch: 'main',
        worktreePath: '/srv/worktrees/feat-x',
      },
    })

    expect(isDispatch(continuing)).toBe(true)
    expect(startsWorktree(continuing)).toBe(false)
    // The user's explicit request for isolation still wins.
    expect(startsWorktree({ ...continuing, worktree: { baseBranch: 'main' } })).toBe(true)
  })

  test('toggling worktree mode off actually turns it off', () => {
    // WHY: the request and the resolved base branch are two fields describing one
    // choice. Flipping only the branch leaves the request set, `startsWorktree`
    // still answers true, and the row the user just unchecked stays checked.
    const inCheckout = runOn('local', 'local', {
      gitContext: { repoRoot: '/repo', branch: 'main', targetBranch: 'main' },
    })

    const on = withWorktreeToggled(inCheckout)
    expect(startsWorktree(on)).toBe(true)
    expect(on.worktree).toEqual({ baseBranch: 'main' })

    const off = withWorktreeToggled(on)
    expect(startsWorktree(off)).toBe(false)
    expect(off.worktree).toBeNull()
  })

  test('changing project keeps the worktree preference but drops its branch', () => {
    // WHY: wanting isolation is about the work, not the folder. The base branch
    // named a branch in the old checkout and would branch from the wrong place.
    const moved = withCheckout(
      runOn('local', 'local', { worktree: { baseBranch: 'main' } }),
      '/other/project',
      null,
    )

    expect(moved.worktree).toEqual({ baseBranch: null })
  })
})

describe('what the Run on picker says about each state', () => {
  const base = {
    hostLabel: 'Studio',
    taskHostLabel: 'This Mac',
    stayLabel: 'Local',
    isolated: false,
    canBranchWorktree: true,
  }

  test('a dispatch names both hosts, because the split is invisible otherwise', () => {
    // WHY: "runs on Studio" alone hides the consequence the user most needs —
    // that the task, and everything filed under it, stays on this machine.
    const target = runTarget({ ...base, run: runOn('studio', 'local'), hostIsLocal: false })

    expect(target.kind).toBe('dispatched')
    expect(target.label).toBe('Studio')
    expect(target.worktreeForced).toBe(true)
    expect(target.taskNote).toBe('Runs on Studio · task stays on This Mac')
  })

  test('a remote project reads as one place, not as a split', () => {
    const target = runTarget({ ...base, run: runOn('studio', 'studio'), hostIsLocal: false })

    expect(target.kind).toBe('remote')
    expect(target.label).toBe('Studio')
    // WHY: the worktree rows stay live here. Forcing isolation would be applying
    // a dispatch's rule to a project that never dispatched.
    expect(target.worktreeForced).toBe(false)
    expect(target.taskNote).toBe('Runs and files tasks on Studio')
  })

  test('local work names the checkout shape and says nothing about hosts', () => {
    const plain = runTarget({ ...base, run: runOn('local', 'local'), hostIsLocal: true })
    expect(plain.kind).toBe('local')
    expect(plain.label).toBe('Local')
    expect(plain.taskNote).toBeNull()

    const branching = runTarget({
      ...base,
      run: runOn('local', 'local', { worktree: { baseBranch: 'main' } }),
      hostIsLocal: true,
    })
    expect(branching.label).toBe('New worktree')
  })

  test('a checkout with no base branch says why the worktree rows are off', () => {
    const target = runTarget({
      ...base,
      run: runOn('local', 'local'),
      hostIsLocal: true,
      canBranchWorktree: false,
    })

    expect(target.worktreeBlockedNote).toBe(
      'This checkout has no base branch to create a worktree from.',
    )
  })
})

import { describe, expect, test } from 'bun:test'
import { CODEBASE_WORKTREE_DEFAULT_MAX, type CodebaseMember } from '@solus/contracts/codebases'
import type { RunConfig, StatusBarCtx } from '@solus/contracts/types'
import { planTaskFolder } from '@solus/server/git/task-folder-plan'
import {
  PLAIN_MEMBER_LINKS_NOTE,
  withWorktreeRepository,
  worktreeRepositoryChoice,
} from '@solus/workspace-ui/components/input/lib/worktree-repositories'
import { memberAt, membersOnHost } from '@solus/workspace-ui/contexts/codebases/host-members'
import { IpcContextBuilder, type IpcContextBuilderDeps } from '@solus/workspace-ui/contexts/workspace/ipc-context'
import {
  adoptGit,
  chooseStart,
  chooseWorktreeRepositories,
  folderLocation,
  startsWorktree,
  worktreeBaseBranch,
  worktreeRepositories,
} from '@solus/workspace-ui/contexts/workspace/run-location'

/**
 * The repositories of a new worktree (docs/plans/codebases.md §7). The host
 * makes the plan. The start control must show the same set before Send, so
 * each case here is checked against the host's own rule.
 */

function member(path: string, patch: Partial<CodebaseMember> = {}): CodebaseMember {
  return { path, name: path.split('/').at(-1)!, state: 'git', repositoryKey: null, rootPath: '/code/shop', discovered: true, hasCommit: true, submodule: false, ...patch }
}

function repositories(count: number): CodebaseMember[] {
  return Array.from({ length: count }, (_unused, index) => member(`/code/shop/repo-${String(index).padStart(2, '0')}`))
}

function chosenPaths(members: CodebaseMember[], working: string, chosen: string[] | null): string[] {
  return worktreeRepositoryChoice(members, working, chosen)!.rows.filter((row) => row.isChosen).map((row) => row.path)
}

function hostPlan(members: CodebaseMember[], working: string, chosen: string[] | null): string[] {
  return (planTaskFolder({ codebaseId: 'shop', workingMember: working, members, repositories: chosen })?.repositories ?? []).map((repository) => repository.path)
}

describe('the default set', () => {
  test(`each repository gets a worktree at ${CODEBASE_WORKTREE_DEFAULT_MAX} repositories, the working repository counted`, () => {
    const members = repositories(CODEBASE_WORKTREE_DEFAULT_MAX)
    const working = members[0]!.path
    const choice = worktreeRepositoryChoice(members, working, null)!
    expect(choice.isDefault).toBe(true)
    expect(choice.note).toBeNull()
    expect(chosenPaths(members, working, null)).toEqual(members.slice(1).map((each) => each.path))
    expect(chosenPaths(members, working, null)).toEqual(hostPlan(members, working, null))
  })

  test(`no repository gets a worktree at ${CODEBASE_WORKTREE_DEFAULT_MAX + 1}, and the control says why`, () => {
    const members = repositories(CODEBASE_WORKTREE_DEFAULT_MAX + 1)
    const working = members[0]!.path
    const choice = worktreeRepositoryChoice(members, working, null)!
    expect(chosenPaths(members, working, null)).toEqual([])
    expect(hostPlan(members, working, null)).toEqual([])
    expect(choice.note).toContain(`more than ${CODEBASE_WORKTREE_DEFAULT_MAX} repositories`)
  })

  // A plain working folder is not a repository, so it is not in the count.
  test('a working folder with no repository does not count', () => {
    const plain = member('/code/shop', { state: 'plain', discovered: false })
    const members = [plain, ...repositories(CODEBASE_WORKTREE_DEFAULT_MAX)]
    expect(chosenPaths(members, plain.path, null)).toHaveLength(CODEBASE_WORKTREE_DEFAULT_MAX)
    expect(chosenPaths(members, plain.path, null)).toEqual(hostPlan(members, plain.path, null))
    expect(worktreeRepositoryChoice(members, plain.path, null)!.working.isRepository).toBe(false)
  })
})

describe('a repository that cannot get a worktree', () => {
  const working = member('/code/shop/web')
  const submodule = member('/code/shop/web/vendor/kit', { submodule: true })
  const empty = member('/code/shop/empty', { hasCommit: false })
  const api = member('/code/shop/api')
  const members = [working, submodule, empty, api]

  test('a submodule and a repository with no commit are not chosen and say why', () => {
    const rows = worktreeRepositoryChoice(members, working.path, null)!.rows
    expect(rows.map((row) => [row.name, row.isChosen, row.refusal?.mark ?? null])).toEqual([
      ['api', true, null],
      ['empty', false, 'No commit'],
      ['kit', false, 'Submodule'],
    ])
    expect(rows.find((row) => row.name === 'kit')!.refusal!.reason).toContain('submodule')
    expect(rows.find((row) => row.name === 'empty')!.refusal!.reason).toContain('no commit')
  })

  test('the person cannot choose one, and the host leaves the same ones out', () => {
    const choice = worktreeRepositoryChoice(members, working.path, null)!
    const paths = withWorktreeRepository(choice, submodule.path, true)
    expect(paths).toEqual([api.path])
    expect(hostPlan(members, working.path, [submodule.path, empty.path, api.path])).toEqual([api.path])
  })
})

describe('the choice of the person', () => {
  const members = [member('/code/shop/web'), member('/code/shop/api'), member('/code/shop/docs')]
  const working = '/code/shop/web'

  test('a change of one row is a list of paths, and the rest keep their state', () => {
    const choice = worktreeRepositoryChoice(members, working, null)!
    const paths = withWorktreeRepository(choice, '/code/shop/docs', false)
    expect(paths).toEqual(['/code/shop/api'])
    const after = worktreeRepositoryChoice(members, working, paths)!
    expect(after.isDefault).toBe(false)
    expect(after.rows.filter((row) => row.isChosen).map((row) => row.name)).toEqual(['api'])
    expect(hostPlan(members, working, paths)).toEqual(paths)
  })

  test('reaches the run location and the context that Send carries', () => {
    const run = {
      location: chooseWorktreeRepositories(
        chooseStart(folderLocation({ serverId: 'host', path: working }, { codebaseId: 'shop', git: { repoRoot: working, branch: 'main', targetBranch: 'main' } }), { kind: 'new-worktree' }),
        ['/code/shop/api'],
      ),
      permissionMode: 'full-access', provider: 'codex',
      modelConfig: { modelId: null, reasoningEffort: 'high', contextWindow: null, fastMode: false },
    } as unknown as RunConfig
    expect(worktreeRepositories(run)).toEqual(['/code/shop/api'])
    const deps = {
      sessionFor: () => undefined, runFor: () => run, hasDraft: () => false, defaultRunConfig: () => run,
      settings: { ctx: {} },
      statusBar: { ctx: {} as StatusBarCtx, ctxFor: () => ({}) as StatusBarCtx, ctxForRun: () => ({}) as StatusBarCtx },
    } as unknown as IpcContextBuilderDeps
    const context = new IpcContextBuilder(deps).sessionCtx('draft')
    expect(context.codebaseId).toBe('shop')
    expect(context.worktreeBaseBranch).toBe('main')
    expect(context.worktreeRepositories).toEqual(['/code/shop/api'])
  })

  test('a folder that is not a member of the codebase on this host has no choice', () => {
    expect(worktreeRepositoryChoice(members, '/code/elsewhere', null)).toBeNull()
  })
})

// A folder with no repository has no branch list. The person names the base
// branch, and a new worktree request must keep it: with no base branch the
// host makes no worktree, and the session starts in the shared folder.
describe('the base branch of a folder with no repository', () => {
  const place = { serverId: 'host', path: '/code/shop' }
  const plain = folderLocation(place, { codebaseId: 'shop' })

  test('the request has no base branch until the person names one', () => {
    const asked = chooseStart(plain, { kind: 'new-worktree' })
    expect(startsWorktree({ location: asked })).toBe(true)
    expect(worktreeBaseBranch({ location: asked })).toBeNull()
    const named = chooseStart(asked, { kind: 'new-worktree', baseBranch: 'release' })
    expect(worktreeBaseBranch({ location: named })).toBe('release')
  })

  test('a Git answer that says the folder is not a repository keeps the branch the person named', () => {
    const named = chooseStart(plain, { kind: 'new-worktree', baseBranch: 'release' })
    // The reader found no checkout, so it has no branch to name.
    const answered = adoptGit(named, place, null, { baseBranch: null })
    expect(worktreeBaseBranch({ location: answered })).toBe('release')
  })

  test('a repository takes the base branch that its host names', () => {
    const git = { repoRoot: '/code/shop', branch: 'main', targetBranch: 'main' }
    const asked = chooseStart(plain, { kind: 'new-worktree', baseBranch: 'release' })
    expect(worktreeBaseBranch({ location: adoptGit(asked, place, git, { baseBranch: 'main' }) })).toBe('main')
    expect(worktreeBaseBranch({ location: adoptGit(asked, place, git, { baseBranch: null }) })).toBeNull()
  })

  test('the control says that the files of the folder are links', () => {
    expect(PLAIN_MEMBER_LINKS_NOTE).toBe('This folder is not a repository, so it has no worktree. Its files are links to the originals: an edit of a linked file changes the original for every session.')
  })
})

describe('the members of a codebase on the run host', () => {
  const root = { installationId: 'install-a', path: '/code/shop', name: 'shop' }
  const groups = [{
    installationId: 'install-a', serverId: 'host', label: 'Host', presence: 'ready' as const, state: 'ready' as const, isStale: false, error: null,
    roots: [{ root, member: member('/code/shop', { state: 'plain', discovered: false }), found: [member('/code/shop/web')], suggestions: [] }],
  }]

  test('are each root, then the repositories found in it', () => {
    const read = membersOnHost(groups, 'host')
    expect(read.isRead).toBe(true)
    expect(read.members.map((each) => each.path)).toEqual(['/code/shop', '/code/shop/web'])
    expect(memberAt(read.members, '/code/shop/')?.state).toBe('plain')
    expect(memberAt(read.members, '/code/shop/web/src')).toBeNull()
  })

  test('a host that the codebase has no folder on has none', () => {
    expect(membersOnHost(groups, 'other')).toEqual({ members: [], isRead: false })
  })
})

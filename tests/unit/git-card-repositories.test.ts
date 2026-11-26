import { afterEach, describe, expect, test } from 'bun:test'
import type { CodebaseMember, SessionFolder } from '@solus/contracts/codebases'
import type { GitState } from '@solus/contracts/types'
import type { CodebaseHostMembers } from '@solus/workspace-ui/contexts/codebases/codebases.store.svelte'
import {
  addRepositoryPlace,
  addRepositoryTooltip,
  candidateRows,
  chosenGitRepository,
  codebaseMembersOn,
  foldGitRepositoryRows,
  gitCardRepositories,
  gitFolderOf,
  gitRepositoryChoice,
  gitRepositoryReading,
  gitRepositoryRowLabel,
  gitRepositoryRows,
  showsRepositoryRows,
  SINGLE_WORKTREE_NOTE,
} from '@solus/workspace-ui/components/project-panel/lib/git-repositories'
import { useDraftRepositoryReads, useGitRepositoryReads, useTaskFolderRead } from '@solus/workspace-ui/components/project-panel/lib/git-repository-reads.svelte'
import { tooltipDisplay } from '@solus/workspace-ui/components/ui/tooltip/content'

/**
 * The repositories of the Git card of the project panel
 * (docs/plans/codebases.md §9, "Running session"). The panel has no
 * Repositories card: the Git card lists the repositories of a session, as it
 * lists its linked pull requests, and its Git rows work in the chosen one.
 */

function folder(path: string, patch: Partial<SessionFolder> = {}): SessionFolder {
  return { path, name: path.split('/').at(-1)!, state: 'git', repositoryPath: path, source: 'codebase', granted: true, ...patch }
}

function member(path: string, rootPath: string, patch: Partial<CodebaseMember> = {}): CodebaseMember {
  return { path, name: path.split('/').at(-1)!, state: 'git', repositoryKey: null, rootPath, discovered: path !== rootPath, hasCommit: true, submodule: false, ...patch }
}

const working = { path: '/code/shop/web', repositoryPath: '/code/shop/web', projectPath: '/code/shop/web' }
const plainWorking = { path: '/code/shop', repositoryPath: null, projectPath: '/code/shop' }

function gitState(branch: string | null, lines?: { insertions: number; deletions: number; fileCount: number }): GitState {
  return {
    repoRoot: '/code/shop/api', headSha: 'abc', branch, targetBranch: 'main', upstreamRef: null, aheadCount: 0, behindCount: 0,
    uncommittedChanges: { files: [], hasMoreFiles: false, fileCount: 0, mergeInProgress: false },
    ...(lines ? { branchChanges: lines } : {}),
  } as GitState
}

describe('the repository rows of the Git card', () => {
  test('the repository of the working directory is first, then each session folder that is a repository', () => {
    const rows = gitRepositoryRows({
      working,
      folders: [folder('/code/shop/api'), folder('/code/notes', { state: 'plain', source: 'attached' }), folder('/code/libs/ui', { source: 'codebase' })],
    })
    // A folder with no repository has no Git state: it is a section of the menu of the Environment card.
    expect(rows.map((row) => [row.name, row.isWorkingDirectory])).toEqual([['web', true], ['api', false], ['ui', false]])
  })

  // WHY: a session with one project and no other repository must see the card as it was before codebases.
  test('a session in one repository has no repository rows', () => {
    const rows = gitRepositoryRows({ working, folders: [folder('/code/notes', { state: 'plain', source: 'attached' })] })
    expect(rows).toHaveLength(1)
    expect(showsRepositoryRows(rows)).toBe(false)
    expect(showsRepositoryRows([])).toBe(false)
  })

  test('a session in more than one repository shows the rows', () => {
    const rows = gitRepositoryRows({ working, folders: [folder('/code/shop/api'), folder('/code/libs/ui')] })
    expect(showsRepositoryRows(rows)).toBe(true)
  })

  // The folder is the place of repositories, not a project that lacks one: the card lists them and says which one it works in.
  test('a working directory with no repository lists the repositories that it holds, also when it holds one', () => {
    const one = gitRepositoryRows({ working: plainWorking, folders: [folder('/code/shop/api')] })
    expect(one.map((row) => [row.name, row.isWorkingDirectory])).toEqual([['api', false]])
    expect(showsRepositoryRows(one)).toBe(true)
  })

  test('a worktree in a task folder is marked as isolated, and Git is read at the worktree', () => {
    const taskFolder = '/data/solus-task-folders/fix-login-1a2b3c4d'
    const rows = gitRepositoryRows({
      working: { path: `${taskFolder}/shop/web`, repositoryPath: '/code/shop/web', projectPath: '/code/shop/web' },
      folders: [folder(`${taskFolder}/shop/api`, { repositoryPath: '/code/shop/api' })],
    })
    expect(rows.map((row) => [row.name, row.isIsolated])).toEqual([['web', true], ['api', true]])
    expect(rows[1]).toMatchObject({ path: `${taskFolder}/shop/api`, repositoryPath: '/code/shop/api' })
  })

  test('the row of a run names the project, and an old list that names the working directory adds no second row', () => {
    const rows = gitRepositoryRows({ working: { ...working, projectPath: '/code/shop/web' }, folders: [folder('/code/shop/web/'), folder('/code/shop/api'), folder('/code/shop/api')] })
    expect(rows.map((row) => row.name)).toEqual(['web', 'api'])
  })
})

describe('the repositories of a task folder session', () => {
  const root = '/data/solus-task-folders/unify-1a2b3c4d'
  const record = {
    primaryPath: `${root}/solus`,
    primaryRepositoryPath: '/code/solus',
    primaryIsWorktree: true,
    repositories: [{ repositoryPath: '/code/solus-cloud', worktreePath: `${root}/solus-cloud`, name: 'solus-cloud' }],
  }
  const inPrimary = { path: `${root}/solus`, repositoryPath: '/code/solus', projectPath: '/code/solus' }
  const cloudFolder = folder(`${root}/solus-cloud`, { repositoryPath: '/code/solus-cloud', name: 'solus-cloud' })

  // WHY: a session moved into its task folder. A Git event for its second
  // worktree moved the run there, and the card showed that repository alone.
  // The record names both repositories, whatever the run's Git state says.
  test('the record names every repository, also when the run took the checkout of the other worktree', () => {
    const moved = { path: `${root}/solus-cloud`, repositoryPath: '/code/solus-cloud', projectPath: '/code/solus-cloud' }
    const rows = gitCardRepositories({ working: moved, sessionFolders: [cloudFolder], members: [], taskFolder: record })
    expect(rows.map((row) => [row.name, row.path, row.isWorkingDirectory])).toEqual([
      ['solus', `${root}/solus`, false],
      ['solus-cloud', `${root}/solus-cloud`, true],
    ])
    // The row of the primary worktree is read as a folder: its Git section does not depend on the run.
    expect(gitFolderOf(rows[0]!)).toEqual({ path: `${root}/solus`, repositoryPath: '/code/solus' })
  })

  test('before the session folders arrive, the worktree of the working directory and the others show', () => {
    const rows = gitCardRepositories({ working: { ...inPrimary, repositoryPath: null }, sessionFolders: [], members: [], taskFolder: record })
    expect(rows.map((row) => [row.name, row.isWorkingDirectory, row.isIsolated])).toEqual([['solus', true, true], ['solus-cloud', false, true]])
    expect(showsRepositoryRows(rows)).toBe(true)
  })

  // A list from before the move names the original checkout; the task folder has its worktree.
  test('an old list that names the original of a repository adds no second row', () => {
    const rows = gitCardRepositories({ working: inPrimary, sessionFolders: [folder('/code/solus-cloud', { name: 'solus-cloud' })], members: [], taskFolder: record })
    expect(rows.map((row) => row.path)).toEqual([`${root}/solus`, `${root}/solus-cloud`])
  })

  test('a folder attached outside the task folder still has its row', () => {
    const rows = gitCardRepositories({ working: inPrimary, sessionFolders: [cloudFolder, folder('/code/notes', { source: 'attached' })], members: [], taskFolder: record })
    expect(rows.map((row) => row.name)).toEqual(['solus', 'solus-cloud', 'notes'])
  })

  test('a primary member that is a plain folder has no row', () => {
    const rows = gitCardRepositories({ working: { ...inPrimary, repositoryPath: null }, sessionFolders: [], members: [], taskFolder: { ...record, primaryIsWorktree: false } })
    expect(rows.map((row) => row.name)).toEqual(['solus-cloud'])
  })

  // A draft has no task folder yet: its card lists what the session will get.
  test('a draft ignores a task folder record', () => {
    const rows = gitCardRepositories({ working, sessionFolders: null, members: [], taskFolder: record })
    expect(rows.map((row) => row.name)).toEqual(['web'])
  })
})

describe('the repositories of a draft', () => {
  const members = [member('/code/shop', '/code/shop', { state: 'plain' }), member('/code/shop/api', '/code/shop'), member('/code/shop/web', '/code/shop')]

  // A draft has no session folders. A folder that holds repositories is a container, and a
  // container is a codebase: the session gets the repositories of its codebase at its first prompt.
  test('a draft in a container lists the repositories of its codebase on the run host', () => {
    const rows = gitCardRepositories({ working: plainWorking, sessionFolders: null, members })
    expect(rows.map((row) => row.name)).toEqual(['api', 'web'])
  })

  // WHY: a draft does not scan its folder. With no codebase there is no list of repositories to show.
  test('a draft with no codebase shows no repository rows', () => {
    expect(gitCardRepositories({ working: plainWorking, sessionFolders: null, members: [] })).toEqual([])
    expect(showsRepositoryRows(gitCardRepositories({ working, sessionFolders: null, members: [] }))).toBe(false)
  })

  test('a draft in a repository shows the card of that repository only', () => {
    const rows = gitCardRepositories({ working, sessionFolders: null, members: [member('/code/shop/web', '/code/shop/web'), member('/code/libs/ui', '/code/libs/ui')] })
    expect(showsRepositoryRows(rows)).toBe(false)
  })

  test('a started session reads its session folders, not the members of its codebase', () => {
    const rows = gitCardRepositories({ working: plainWorking, sessionFolders: [folder('/code/shop/api')], members })
    expect(rows.map((row) => row.name)).toEqual(['api'])
  })

  // The store groups the roots of a codebase by host. The card of a draft reads the run host only.
  test('the members of a codebase on the run host are its roots and the repositories found in them', () => {
    const group = (serverId: string | null, rootPath: string, found: CodebaseMember[]): CodebaseHostMembers => ({
      installationId: `install-${serverId}`, serverId, label: serverId, presence: 'ready', state: 'ready', isStale: false, error: null,
      roots: [{ root: { installationId: `install-${serverId}`, path: rootPath, name: rootPath.split('/').at(-1)! }, member: member(rootPath, rootPath, { state: 'plain' }), found, suggestions: [] }],
    })
    const groups = [group('laptop', '/code/shop', [member('/code/shop/api', '/code/shop'), member('/code/shop/web', '/code/shop')]), group('build', '/srv/infra', [member('/srv/infra/deploy', '/srv/infra')])]
    expect(codebaseMembersOn(groups, 'laptop').map((each) => each.path)).toEqual(['/code/shop', '/code/shop/api', '/code/shop/web'])
    expect(codebaseMembersOn(groups, 'phone')).toEqual([])
  })
})

describe('the fold of a long list of repositories', () => {
  const namesOf = (rows: readonly { name: string }[]) => rows.map((row) => row.name)
  const five = gitRepositoryRows({ working, folders: ['api', 'docs', 'infra', 'ui'].map((name) => folder(`/code/shop/${name}`)) })
  const keyOf = (name: string) => five.find((row) => row.name === name)!.key

  // WHY: a container can hold many repositories. The Git rows below the list must stay in reach.
  test('five repositories show four rows, then the row that opens the rest', () => {
    const fold = foldGitRepositoryRows(five, keyOf('web'), false)
    expect(namesOf(fold.visible)).toEqual(['web', 'api', 'docs', 'infra'])
    expect(fold).toMatchObject({ toggleLabel: 'Show 1 more', isExpanded: false })
  })

  // WHY: the Git rows work in the chosen repository, so the card must always say which one it is.
  test('the chosen repository always shows: the fifth one takes the place of the fourth', () => {
    const fold = foldGitRepositoryRows(five, keyOf('ui'), false)
    expect(namesOf(fold.visible)).toEqual(['web', 'api', 'docs', 'ui'])
    expect(fold.toggleLabel).toBe('Show 1 more')
  })

  test('the open list shows each row in the order of the list, and the row that closes it', () => {
    const fold = foldGitRepositoryRows(five, keyOf('ui'), true)
    expect(namesOf(fold.visible)).toEqual(['web', 'api', 'docs', 'infra', 'ui'])
    expect(fold).toMatchObject({ toggleLabel: 'Show less', isExpanded: true })
  })

  test('the row says how many repositories it opens', () => {
    const eight = gitRepositoryRows({ working, folders: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) => folder(`/code/shop/${name}`)) })
    expect(foldGitRepositoryRows(eight, eight[6]!.key, false)).toMatchObject({ toggleLabel: 'Show 4 more' })
    expect(namesOf(foldGitRepositoryRows(eight, eight[6]!.key, false).visible)).toEqual(['web', 'a', 'b', 'f'])
  })

  test('four repositories or fewer have no fold row, also after a long list was opened', () => {
    const four = five.slice(0, 4)
    expect(foldGitRepositoryRows(four, keyOf('web'), false)).toEqual({ visible: four, toggleLabel: null, isExpanded: false })
    expect(foldGitRepositoryRows(four, keyOf('web'), true)).toEqual({ visible: four, toggleLabel: null, isExpanded: false })
    expect(foldGitRepositoryRows([], null, false).toggleLabel).toBeNull()
  })

  // The rows of a draft open their files: no row is the chosen one.
  test('a draft with no chosen row shows the first four', () => {
    expect(namesOf(foldGitRepositoryRows(five, null, false).visible)).toEqual(['web', 'api', 'docs', 'infra'])
  })
})

describe('the repository that the Git rows work in', () => {
  const rows = gitRepositoryRows({ working, folders: [folder('/code/shop/api'), folder('/code/libs/ui')] })

  test('the repository of the working directory is chosen at first, and the Git section works in the place of the run', () => {
    const chosen = chosenGitRepository(rows, null)
    expect(chosen?.name).toBe('web')
    expect(gitFolderOf(chosen)).toBeNull()
  })

  test('a choice of a session folder aims the Git section at that folder', () => {
    const api = rows[1]!
    const stored = gitRepositoryChoice(rows, api)
    expect(stored).toBe('/code/shop/api')
    const chosen = chosenGitRepository(rows, stored)
    expect(chosen?.key).toBe(api.key)
    expect(gitFolderOf(chosen)).toEqual({ path: '/code/shop/api', repositoryPath: '/code/shop/api' })
  })

  // The choice of the first row is stored as no choice, so a session that moves into a worktree follows its working directory.
  test('a choice of the first row stores no path', () => {
    expect(gitRepositoryChoice(rows, rows[0]!)).toBeNull()
  })

  test('a folder that left the session puts the choice back on the first repository', () => {
    const without = gitRepositoryRows({ working, folders: [folder('/code/libs/ui')] })
    expect(chosenGitRepository(without, '/code/shop/api')?.name).toBe('web')
  })

  test('in a working directory with no repository, the first repository that it holds is chosen', () => {
    const inFolder = gitRepositoryRows({ working: plainWorking, folders: [folder('/code/shop/api'), folder('/code/shop/web')] })
    const chosen = chosenGitRepository(inFolder, null)
    expect(chosen?.name).toBe('api')
    expect(gitFolderOf(chosen)).toEqual({ path: '/code/shop/api', repositoryPath: '/code/shop/api' })
  })

  // The chosen row has `aria-current`. Its label says what a choice does, because the rows are a choice, not a link.
  test('a screen reader hears which repository is chosen, and what a choice does', () => {
    expect(gitRepositoryRowLabel(rows[0]!, true)).toBe('web, the working directory: the Git actions below work in this repository')
    expect(gitRepositoryRowLabel(rows[1]!, false)).toBe('api: work in this repository with the Git actions below')
  })
})

describe('what a repository row shows', () => {
  const [, api] = gitRepositoryRows({ working, folders: [folder('/code/shop/api')] })

  // The Git rows below the divider name the branch of the chosen repository: a row keeps its branch in the tooltip.
  test('the line counts of its own checkout, and its branch only in the tooltip', () => {
    const reading = gitRepositoryReading(api!, gitState('fix-login', { insertions: 12, deletions: 3, fileCount: 2 }))
    expect(reading.badge).toBeUndefined()
    expect(reading.tooltip).toContain('Branch fix-login')
    expect(reading.diffStat).toMatchObject({ insertions: 12, deletions: 3 })
    // Before the host answers, the row names no branch that it does not know.
    expect(gitRepositoryReading(api!, undefined).tooltip).not.toMatch(/Branch|Detached/)
    expect(gitRepositoryReading(api!, gitState(null)).tooltip).toContain('Detached HEAD')
  })

  // The agent was not given an observed folder: Solus shows what a tool changed there, for review.
  test('a repository that is not attached says so in place of its branch', () => {
    const [, observed] = gitRepositoryRows({ working, folders: [folder('/code/other', { source: 'observed', granted: false })] })
    const reading = gitRepositoryReading(observed!, gitState('main'))
    expect(reading.badge).toBe('Not attached')
    expect(reading.tooltip).toContain('Branch main')
  })

  // The tooltip of a row is one line of text: a line break shows as a space, and two facts then read as one.
  test('the facts of the tooltip show on one line, each apart from the next', () => {
    const { tooltip } = gitRepositoryReading(api!, gitState('fix-login', { insertions: 12, deletions: 3, fileCount: 2 }))
    expect(tooltip).not.toContain('\n')
    expect(tooltip.split(' · ')[0]).toBe('/code/shop/api')
    expect(tooltip.split(' · ').length).toBeGreaterThan(1)
    expect(tooltipDisplay(tooltip)).toEqual({ label: tooltip })
  })
})

// WHY: the row showed in task folder sessions only, so it looked as if it came and went at random.
// Each started session that the person may change has it; what it does depends on where the session works.
describe('"Add repository" in every session', () => {
  test('a task folder session makes a worktree', () => {
    expect(addRepositoryPlace('/data/solus-task-folders/fix-login-1a2b3c4d/shop')).toBe('task-folder')
    expect(addRepositoryTooltip('task-folder')).toContain('worktree')
  })

  test('a session in its project folder attaches a chosen repository', () => {
    expect(addRepositoryPlace('/code/shop/web')).toBe('folder')
    expect(addRepositoryTooltip('folder')).toContain('Choose a repository')
  })

  // One worktree inside its repository cannot hold a second repository: the row says why instead of hiding.
  test('a single worktree says why it cannot hold a second repository', () => {
    expect(addRepositoryPlace('/code/shop/web/.git/solus/worktrees/fix-login')).toBe('worktree')
    expect(addRepositoryTooltip('worktree')).toBe(SINGLE_WORKTREE_NOTE)
  })
})

describe('"Add repository" in a task folder session', () => {
  test('lists the candidates of the host by name', () => {
    expect(candidateRows([member('/code/shop/web', '/code/shop'), member('/code/shop/api', '/code/shop')])).toEqual([
      { path: '/code/shop/api', name: 'api' },
      { path: '/code/shop/web', name: 'web' },
    ])
  })
})

// The reads of the rows. A `.svelte.ts` module is not compiled in a unit test,
// so the test supplies `$effect` and runs the effects itself.
const runtime = globalThis as typeof globalThis & { $effect?: (effect: () => void | (() => void)) => void; $state?: <T>(value: T) => T }
const previousEffect = runtime.$effect
const previousState = runtime.$state
afterEach(() => {
  if (previousEffect) runtime.$effect = previousEffect
  else delete runtime.$effect
  if (previousState) runtime.$state = previousState
  else delete runtime.$state
})

test('each repository row holds the details of its own checkout, and a hidden card holds none', () => {
  const effects: Array<() => void | (() => void)> = []
  let cleanups: Array<void | (() => void)> = []
  runtime.$effect = (effect) => { effects.push(effect) }
  const update = () => {
    for (const cleanup of cleanups) cleanup?.()
    cleanups = effects.map((effect) => effect())
  }
  const state = { active: false, pathsKey: '/code/shop/web\n/code/shop/api' }
  const held = new Map<string, number>()
  const holding = () => [...held].filter(([, count]) => count > 0).map(([key]) => key).sort()
  useGitRepositoryReads({
    get active() { return state.active },
    serverId: 'host',
    get pathsKey() { return state.pathsKey },
    environment: {
      watchDetails: (serverId, cwd) => {
        const key = `${serverId} ${cwd}`
        held.set(key, (held.get(key) ?? 0) + 1)
        return () => { held.set(key, held.get(key)! - 1) }
      },
    },
  })
  update()
  expect(holding()).toEqual([])

  state.active = true
  update()
  expect(holding()).toEqual(['host /code/shop/api', 'host /code/shop/web'])

  state.pathsKey = '/code/shop/web'
  update()
  expect(holding()).toEqual(['host /code/shop/web'])

  state.active = false
  update()
  expect(holding()).toEqual([])
})

test('the card of a draft holds its codebase and the members of it, and a started session holds none here', () => {
  const effects: Array<() => void | (() => void)> = []
  let cleanups: Array<void | (() => void)> = []
  runtime.$effect = (effect) => { effects.push(effect) }
  const update = () => {
    for (const cleanup of cleanups) cleanup?.()
    cleanups = effects.map((effect) => effect())
  }
  const state = { active: true, codebaseId: null as string | null }
  const held = new Map<string, number>()
  const hold = (key: string) => { held.set(key, (held.get(key) ?? 0) + 1); return () => { held.set(key, held.get(key)! - 1) } }
  const holding = () => [...held].filter(([, count]) => count > 0).map(([key]) => key).sort()
  useDraftRepositoryReads({
    get active() { return state.active },
    get codebaseId() { return state.codebaseId },
    codebases: { watch: () => hold('codebases'), watchMembers: (id) => hold(`members ${id}`) },
  })
  // A started session, and a draft with no codebase, name no codebase here.
  update()
  expect(holding()).toEqual([])

  state.codebaseId = 'shop'
  update()
  expect(holding()).toEqual(['codebases', 'members shop'])

  state.active = false
  update()
  expect(holding()).toEqual([])
})

test('the task folder record is read by the root of the task folder, again when the folders change, and never for a hidden card', async () => {
  const effects: Array<() => void | (() => void)> = []
  let cleanups: Array<void | (() => void)> = []
  runtime.$effect = (effect) => { effects.push(effect) }
  runtime.$state = <T>(value: T) => value
  const update = async () => {
    for (const cleanup of cleanups) cleanup?.()
    cleanups = effects.map((effect) => effect())
    await Promise.resolve()
    await Promise.resolve()
  }
  const root = '/data/solus-task-folders/unify-1a2b3c4d'
  const record = { root, anchor: '/code', primaryPath: `${root}/solus`, primaryRepositoryPath: '/code/solus', primaryIsWorktree: true, branch: 'solus/unify', repositories: [] }
  const reads: string[] = []
  const state = { active: false, path: `${root}/solus-cloud` as string | null, foldersKey: '' }
  const taskFolder = useTaskFolderRead({
    get active() { return state.active },
    get path() { return state.path },
    get foldersKey() { return state.foldersKey },
    read: async (path) => { reads.push(path); return record },
  })
  await update()
  expect(reads).toEqual([])
  expect(taskFolder.current).toBeNull()

  // A run whose Git state names another worktree of the task folder still finds it.
  state.active = true
  await update()
  expect(reads).toEqual([root])
  expect(taskFolder.current).toBe(record)

  state.foldersKey = `${root}/solus-cloud`
  await update()
  expect(reads).toEqual([root, root])

  // A path outside a task folder has no record, and the last answer is not shown for it.
  state.path = '/code/solus'
  await update()
  expect(reads).toEqual([root, root])
  expect(taskFolder.current).toBeNull()
})

import { afterEach, describe, expect, test } from 'bun:test'
import type { CodebaseMember, SessionFolder } from '@solus/contracts/codebases'
import type { GitState } from '@solus/contracts/types'
import {
  candidateRows,
  chosenGitRepository,
  gitCardRepositories,
  gitFolderOf,
  gitRepositoriesDetail,
  gitRepositoryChoice,
  gitRepositoryReading,
  gitRepositoryRowLabel,
  gitRepositoryRows,
  showsRepositoryRows,
} from '@solus/workspace-ui/components/project-panel/lib/git-repositories'
import { useGitRepositoryReads } from '@solus/workspace-ui/components/project-panel/lib/git-repository-reads.svelte'
import { tooltipDisplay } from '@solus/workspace-ui/components/ui/tooltip/content'

/**
 * The repositories of the Git card of the project panel
 * (docs/plans/codebases.md §9, "Running session"). The panel has no
 * Repositories card: the Git card lists the repositories of a session, as it
 * lists its linked pull requests, and its Git rows work in the chosen one.
 */

function folder(path: string, patch: Partial<SessionFolder> = {}): SessionFolder {
  return { path, name: path.split('/').at(-1)!, state: 'git', repositoryPath: path, source: 'project', granted: true, ...patch }
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
    // A folder with no repository has no Git state: it is a row of the Environment card.
    expect(rows.map((row) => [row.name, row.isWorkingDirectory])).toEqual([['web', true], ['api', false], ['ui', false]])
  })

  // WHY: a session with one project and no other repository must see the card as it was before codebases.
  test('a session in one repository has no repository rows', () => {
    const rows = gitRepositoryRows({ working, folders: [folder('/code/notes', { state: 'plain', source: 'attached' })] })
    expect(rows).toHaveLength(1)
    expect(showsRepositoryRows(rows)).toBe(false)
    expect(gitRepositoriesDetail(rows)).toBeUndefined()
    expect(showsRepositoryRows([])).toBe(false)
  })

  test('a session in more than one repository shows the rows, and the card says how many', () => {
    const rows = gitRepositoryRows({ working, folders: [folder('/code/shop/api'), folder('/code/libs/ui')] })
    expect(showsRepositoryRows(rows)).toBe(true)
    expect(gitRepositoriesDetail(rows)).toBe('3 repositories')
  })

  // The folder is the place of repositories, not a project that lacks one: the card lists them and says which one it works in.
  test('a working directory with no repository lists the repositories that it holds, also when it holds one', () => {
    const one = gitRepositoryRows({ working: plainWorking, folders: [folder('/code/shop/api')] })
    expect(one.map((row) => [row.name, row.isWorkingDirectory])).toEqual([['api', false]])
    expect(showsRepositoryRows(one)).toBe(true)
    expect(gitRepositoriesDetail(one)).toBe('1 repository')
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

describe('the repositories of a draft', () => {
  const found = [member('/code/shop', '/code/shop', { state: 'plain' }), member('/code/shop/api', '/code/shop'), member('/code/shop/web', '/code/shop')]

  // A draft has no session folders. A project covers the repositories inside it, so the session gets them at its first prompt.
  test('a draft in a folder with no repository lists the repositories that the host found in it', () => {
    const rows = gitCardRepositories({ working: plainWorking, sessionFolders: null, found })
    expect(rows.map((row) => row.name)).toEqual(['api', 'web'])
  })

  test('a draft in a repository shows the card of that repository only', () => {
    const rows = gitCardRepositories({ working, sessionFolders: null, found: [member('/code/shop/web', '/code/shop/web'), member('/code/shop/web/vendor/lib', '/code/shop/web')] })
    expect(showsRepositoryRows(rows)).toBe(false)
  })

  test('a started session reads its session folders, not the scan', () => {
    const rows = gitCardRepositories({ working: plainWorking, sessionFolders: [folder('/code/shop/api')], found })
    expect(rows.map((row) => row.name)).toEqual(['api'])
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

  test('the branch and the line counts of its own checkout', () => {
    const reading = gitRepositoryReading(api!, gitState('fix-login', { insertions: 12, deletions: 3, fileCount: 2 }))
    expect(reading.badge).toBe('fix-login')
    expect(reading.diffStat).toMatchObject({ insertions: 12, deletions: 3 })
    // Before the host answers, the row shows no branch that it does not know.
    expect(gitRepositoryReading(api!, undefined).badge).toBeUndefined()
    expect(gitRepositoryReading(api!, gitState(null)).badge).toBe('Detached HEAD')
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
const runtime = globalThis as typeof globalThis & { $effect?: (effect: () => void | (() => void)) => void }
const previousEffect = runtime.$effect
afterEach(() => {
  if (previousEffect) runtime.$effect = previousEffect
  else delete runtime.$effect
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

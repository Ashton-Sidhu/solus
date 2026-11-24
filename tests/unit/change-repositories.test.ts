import { describe, expect, test } from 'bun:test'
import type { ChangedFileStat } from '@solus/contracts/git-types'
import type { DigestTurn, SessionChangeSummary, SessionDigest } from '@solus/contracts/session-digest'
import {
  repositoryChanges,
  repositoryOfSummaryFile,
  sessionFolderFiles,
  summaryFilePath,
  summaryPaths,
  summaryRepositories,
} from '@solus/workspace-ui/components/conversation/lib/change-repositories'
import { buildDiffSummaryTree, flattenDiffTree } from '@solus/workspace-ui/components/conversation/lib/diff-summary-tree'
import type { DiffRepository } from '@solus/workspace-ui/components/diff/lib/diff-repositories'
import { changeTree } from '@solus/workspace-ui/components/session/artifacts/lib/change-tree'

// The summary of a session that works in `web` and has the session folder
// `api` beside it (docs/plans/codebases.md §8).
const WEB: DiffRepository = { path: '/work/web', name: 'web', isWorkingDirectory: true }
const API: DiffRepository = { path: '/work/api', name: 'api', isWorkingDirectory: false }

function stat(path: string, additions: number, deletions = 0): ChangedFileStat {
  return { path, additions, deletions, status: 'M' }
}

function turn(endedAt: number, changes: DigestTurn['changes'], settled = true): DigestTurn {
  return { id: `turn-${endedAt}`, startedAt: endedAt - 50, endedAt, settled, prompt: '', toolCalls: [], changes }
}

const TWO_REPOSITORIES: SessionChangeSummary = {
  filesChanged: 3,
  additions: 12,
  deletions: 4,
  files: [stat('src/app.ts', 7, 3), stat('../api/src/main.ts', 4, 1), stat('../api/README.md', 1)],
  repositories: [
    { repositoryPath: '/work/web', name: 'web', filesChanged: 1, additions: 7, deletions: 3, files: [stat('src/app.ts', 7, 3)] },
    { repositoryPath: '/work/api', name: 'api', filesChanged: 2, additions: 5, deletions: 1, files: [stat('src/main.ts', 4, 1), stat('README.md', 1)] },
  ],
}

function digest(changes: SessionChangeSummary | null, turns: DigestTurn[] = []): Pick<SessionDigest, 'changes' | 'turns'> {
  return { changes, turns }
}

describe('the breakdown of a change by repository', () => {
  test('with `repositories`, each repository is one row with its name and its counts', () => {
    expect(repositoryChanges(digest(TWO_REPOSITORIES))).toEqual([
      { repositoryPath: '/work/web', name: 'web', filesChanged: 1, additions: 7, deletions: 3 },
      { repositoryPath: '/work/api', name: 'api', filesChanged: 2, additions: 5, deletions: 1 },
    ])
  })

  test('without `repositories`, one repository holds the change and there is no breakdown', () => {
    // The host leaves the field out when one repository changed: the totals are that repository's.
    const oneRepository: SessionChangeSummary = { filesChanged: 1, additions: 7, deletions: 3, files: [stat('src/app.ts', 7, 3)] }
    expect(repositoryChanges(digest(oneRepository))).toEqual([])
    expect(repositoryChanges(digest(null))).toEqual([])
    expect(repositoryChanges(null)).toEqual([])
  })

  test('a turn card gets the breakdown of its own turn, not of the session', () => {
    const both = { filesChanged: 2, additions: 3, deletions: 0, repositories: [
      { repositoryPath: '/work/web', name: 'web', filesChanged: 1, additions: 1, deletions: 0 },
      { repositoryPath: '/work/api', name: 'api', filesChanged: 1, additions: 2, deletions: 0 },
    ] }
    const webOnly = { filesChanged: 1, additions: 9, deletions: 0 }
    const session = digest(TWO_REPOSITORIES, [turn(100, webOnly), turn(200, both), turn(300, webOnly)])
    // The second turn ran from its prompt at 150 until the next prompt at 250.
    expect(repositoryChanges(session, { from: 150, until: 250 }).map((row) => [row.name, row.additions])).toEqual([['web', 1], ['api', 2]])
    // The turns beside it changed one repository: they have no breakdown.
    expect(repositoryChanges(session, { from: 50, until: 150 })).toEqual([])
    expect(repositoryChanges(session, { from: 250, until: null })).toEqual([])
  })

  test('a turn that still runs has no checkpoint, so it has no breakdown', () => {
    const running = turn(200, { filesChanged: 2, additions: 3, deletions: 0, repositories: TWO_REPOSITORIES.repositories }, false)
    expect(repositoryChanges(digest(null, [running]), { from: 150, until: null })).toEqual([])
  })
})

describe('the files of a summary, by repository', () => {
  const repositories = summaryRepositories([WEB, API])

  test('a session with one repository names no repository beside its files', () => {
    expect(summaryRepositories([WEB])).toEqual([])
    const tree = buildDiffSummaryTree(undefined, [stat('src/app.ts', 1), stat('lib/util.ts', 1)], summaryRepositories([WEB]))
    expect(flattenDiffTree(tree, new Set(), new Set()).map((row) => row.kind === 'folder' && row.node.label)).toEqual(['src', 'lib'])
  })

  test('with more than one repository, each file is below a folder with its repository name', () => {
    const tree = buildDiffSummaryTree(undefined, TWO_REPOSITORIES.files, repositories)
    const top = flattenDiffTree(tree, new Set(), new Set())
    // `../api` reads `api`: the reader sees the repository, not the way to it. A row has the repository's counts.
    expect(top.map((row) => row.kind === 'folder' && [row.node.label, row.node.fileCount, row.node.additions])).toEqual([
      ['web/src', 1, 7],
      ['api', 2, 5],
    ])
    // A file keeps the session's path: that is what opens its diff in the right repository.
    const opened = flattenDiffTree(tree, new Set(['../api', '../api/src']), new Set())
    expect(opened.flatMap((row) => (row.kind === 'file' ? [row.node.path] : []))).toEqual(['../api/src/main.ts', '../api/README.md'])
  })

  test('the Threads surface draws the same tree', () => {
    const changes = TWO_REPOSITORIES.files.map((file) => ({ ...file }))
    const labels = flattenDiffTree(changeTree(changes, repositories), new Set(), new Set()).map((row) => row.kind === 'folder' && row.node.label)
    expect(labels).toEqual(['api', 'web/src'])
  })

  test('the files of the session folders come from the host summary: git here counts the working directory only', () => {
    expect(sessionFolderFiles(TWO_REPOSITORIES, repositories).map((file) => file.path)).toEqual(['../api/src/main.ts', '../api/README.md'])
    expect(sessionFolderFiles(TWO_REPOSITORIES, [])).toEqual([])
  })

  test('a path that the transcript names by its absolute path is the same file as the one the host lists', () => {
    const paths = summaryPaths(['src/app.ts', '/work/api/src/main.ts'], [WEB, API], [stat('../api/src/main.ts', 4, 1)])
    expect(paths).toEqual(['src/app.ts', '../api/src/main.ts'])
    // One repository: the list is the session's own list.
    const own = ['src/app.ts']
    expect(summaryPaths(own, [WEB], [])).toBe(own)
    expect(summaryPaths(undefined, [WEB, API], [])).toBeUndefined()
  })

  test('a file of a repository inside the working directory belongs to the inner repository', () => {
    const docs: DiffRepository = { path: '/work/web/docs', name: 'docs', isWorkingDirectory: false }
    const nested = summaryRepositories([WEB, docs])
    expect(repositoryOfSummaryFile('docs/guide.md', nested)).toEqual({ repository: { prefix: 'docs', name: 'docs' }, path: 'guide.md' })
    expect(repositoryOfSummaryFile('docs-site/index.md', nested)?.repository.name).toBe('web')
  })

  test('a file of a session folder opens in the file pane by its real path', () => {
    expect(summaryFilePath('../api/src/main.ts', [WEB, API])).toBe('/work/api/src/main.ts')
    expect(summaryFilePath('src/app.ts', [WEB, API])).toBe('src/app.ts')
  })
})

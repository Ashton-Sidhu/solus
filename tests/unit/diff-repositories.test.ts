import { describe, expect, test } from 'bun:test'
import type { SessionFolder } from '@solus/contracts/codebases'
import type { DiffComment, TurnSnapshot } from '@solus/contracts/types'
import {
  chosenDiffRepository,
  commentsOfRepository,
  diffFileOfSessionPath,
  diffRepositories,
  diffRepositoryNamed,
  hasRepositoryChoice,
  scopeInRepository,
  sessionPathOfDiffFile,
  type RepositorySession,
} from '@solus/workspace-ui/components/diff/lib/diff-repositories'
import { folderLocation } from '@solus/workspace-ui/contexts/workspace/run-location'

// One session of a codebase: it works in `web`, and it has `api` beside it,
// `web/docs` (a repository inside the working directory), and a plain folder.
const WEB = '/work/web'

function folder(path: string, name: string, extra: Partial<SessionFolder> = {}): SessionFolder {
  return { path, name, state: 'git', repositoryPath: path, source: 'codebase', granted: true, ...extra }
}

const API = folder('/work/api', 'api')
const DOCS = folder('/work/web/docs', 'docs')
const NOTES = folder('/work/notes', 'notes', { state: 'plain' })

function sessionWith(sessionFolders: SessionFolder[]): RepositorySession {
  return {
    run: { location: folderLocation({ serverId: 'local', path: WEB }, { git: { branch: 'main', targetBranch: 'main', repoRoot: WEB } }) },
    sessionFolders,
  }
}

function turn(index: number, traceId?: string): TurnSnapshot {
  return {
    index,
    fromTreeSha: 'from',
    toTreeSha: 'to',
    sha: 'sha',
    timestamp: index,
    partial: false,
    userMessagePreview: '',
    traceId,
    filesChanged: 1,
    additions: 1,
    deletions: 0,
  }
}

function comment(id: string, filePath: string): DiffComment {
  return { id, filePath, startLine: 1, endLine: 1, side: 'new', selectedCode: '', comment: id, createdAt: 0 }
}

describe('the repositories of the diff panel', () => {
  test('the working directory comes first, then each git session folder', () => {
    const repositories = diffRepositories(sessionWith([API, NOTES, DOCS]))
    expect(repositories).toEqual([
      { path: WEB, name: 'web', isWorkingDirectory: true },
      { path: '/work/api', name: 'api', isWorkingDirectory: false },
      { path: '/work/web/docs', name: 'docs', isWorkingDirectory: false },
    ])
  })

  test('a plain folder has no diff, so a session with only plain folders gets no picker', () => {
    // The picker shows only when the reader has a choice to make.
    expect(hasRepositoryChoice(diffRepositories(sessionWith([NOTES])))).toBe(false)
    expect(hasRepositoryChoice(diffRepositories(sessionWith([])))).toBe(false)
    expect(hasRepositoryChoice(diffRepositories(sessionWith([API])))).toBe(true)
  })

  test('with no choice yet, the picker is on the working directory', () => {
    const repositories = diffRepositories(sessionWith([API]))
    expect(chosenDiffRepository(repositories, null)?.path).toBe(WEB)
    expect(chosenDiffRepository(repositories, '/work/api')?.name).toBe('api')
  })

  test('a folder that leaves the session puts the picker back on the working directory', () => {
    // The choice is stored by path. A request for a folder that is not a
    // repository of the session is refused by the host, so the stored path
    // must not reach a request after the folder is detached.
    const afterDetach = diffRepositories(sessionWith([]))
    const chosen = chosenDiffRepository(afterDetach, '/work/api')
    expect(chosen).toEqual({ path: WEB, name: 'web', isWorkingDirectory: true })
  })

  test('a change summary names a worktree folder by its repository, and that opens the worktree', () => {
    // In a task folder the session works in a worktree; the summary names the member it stands in for.
    const worktree = folder('/data/solus-task-folders/fix-1a2b3c4d/api', 'api', { repositoryPath: '/work/api' })
    const session = sessionWith([worktree])
    expect(diffRepositoryNamed(session, '/work/api')?.path).toBe(worktree.path)
    expect(diffRepositoryNamed(session, worktree.path)?.path).toBe(worktree.path)
    // The repository root of the working directory, and each unknown path, is the working directory.
    expect(diffRepositoryNamed(session, WEB)?.isWorkingDirectory).toBe(true)
    expect(diffRepositoryNamed(session, '/somewhere/else')?.isWorkingDirectory).toBe(true)
  })
})

describe('one turn in two repositories', () => {
  // Each repository counts its own snapshots: the third turn of the session is
  // snapshot 2 of `web` and snapshot 0 of `api`, which the first two turns left alone.
  const webTurns = [turn(0, 'trace-a'), turn(1, 'trace-b'), turn(2, 'trace-c')]
  const apiTurns = [turn(0, 'trace-c')]

  test('the selected turn is kept by its trace, not by its index', () => {
    expect(scopeInRepository({ kind: 'turn', index: 2 }, webTurns, apiTurns)).toEqual({ kind: 'turn', index: 0 })
    expect(scopeInRepository({ kind: 'turn', index: 0 }, apiTurns, webTurns)).toEqual({ kind: 'turn', index: 2 })
  })

  test('a turn that left the other repository alone becomes the session scope there', () => {
    // Index 1 exists in neither list of `api`; to keep the index would show a different turn.
    expect(scopeInRepository({ kind: 'turn', index: 1 }, webTurns, apiTurns)).toEqual({ kind: 'session' })
  })

  test('a snapshot with no trace cannot be joined, so it also becomes the session scope', () => {
    expect(scopeInRepository({ kind: 'turn', index: 0 }, [turn(0)], [turn(0)])).toEqual({ kind: 'session' })
  })

  test('each other scope is the same in each repository', () => {
    expect(scopeInRepository({ kind: 'working-tree' }, webTurns, apiTurns)).toEqual({ kind: 'working-tree' })
    expect(scopeInRepository(undefined, webTurns, apiTurns)).toBeUndefined()
  })
})

describe('queued comments of a session with more than one repository', () => {
  const repositories = diffRepositories(sessionWith([API, DOCS]))
  const [web, api, docs] = repositories

  test('a comment in a session folder is stored with the folder in front, so the agent finds the file', () => {
    expect(sessionPathOfDiffFile(api!, repositories, 'src/main.ts')).toBe('../api/src/main.ts')
    expect(sessionPathOfDiffFile(docs!, repositories, 'guide.md')).toBe('docs/guide.md')
    expect(sessionPathOfDiffFile(web!, repositories, 'src/main.ts')).toBe('src/main.ts')
  })

  test('each repository shows only its own comments, also when two repositories have the same file path', () => {
    const comments = [
      comment('web', 'src/main.ts'),
      comment('api', '../api/src/main.ts'),
      comment('docs', 'docs/guide.md'),
    ]
    expect(commentsOfRepository(comments, web!, repositories).map((each) => [each.id, each.filePath])).toEqual([['web', 'src/main.ts']])
    expect(commentsOfRepository(comments, api!, repositories).map((each) => [each.id, each.filePath])).toEqual([['api', 'src/main.ts']])
    // A repository inside the working directory owns its files: the longest folder wins.
    expect(commentsOfRepository(comments, docs!, repositories).map((each) => [each.id, each.filePath])).toEqual([['docs', 'guide.md']])
  })

  test('a session with one repository keeps its comments as they are', () => {
    const single = diffRepositories(sessionWith([]))
    const comments = [comment('a', 'src/main.ts')]
    expect(commentsOfRepository(comments, single[0]!, single)).toBe(comments)
  })

  test('a session path gives back its repository and the path in that repository', () => {
    expect(diffFileOfSessionPath(repositories, '../api/src/main.ts')).toEqual({ repository: api!, path: 'src/main.ts' })
    expect(diffFileOfSessionPath(repositories, 'src/main.ts')).toEqual({ repository: web!, path: 'src/main.ts' })
  })
})

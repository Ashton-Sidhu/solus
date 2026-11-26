import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TaskFolderRecord } from '@solus/server/git/task-folder-store'

mock.module('node:sqlite', () => ({ DatabaseSync }))
// The host's git probe asks `xcode-select`, which a sandbox can refuse.
const gitAvailability = await import('@solus/server/git/git-availability')
mock.module('@solus/server/git/git-availability', () => ({ ...gitAvailability, isGitUsable: () => true }))

const root = realpathSync(mkdtempSync(join(tmpdir(), 'solus-managed-worktrees-')))
const previousDataDir = process.env.SOLUS_DATA_DIR
process.env.SOLUS_DATA_DIR = join(root, 'data')

let managed: typeof import('@solus/server/git/managed-worktrees')
let taskFolderStore: typeof import('@solus/server/git/task-folder-store')
beforeAll(async () => {
  ;(await import('@solus/server/execution/seats/acting-identity')).actAsHostForTests()
  managed = await import('@solus/server/git/managed-worktrees')
  taskFolderStore = await import('@solus/server/git/task-folder-store')
})
afterAll(() => {
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
  rmSync(root, { recursive: true, force: true })
})

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

let repoCount = 0
function makeRepo(name = `repo-${++repoCount}`): string {
  const repo = join(root, name)
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  writeFileSync(join(repo, 'README.md'), 'hello\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'init')
  return repo
}

function addManaged(repo: string, slug: string, branch: string): string {
  const path = join(repo, '.git', 'solus', 'worktrees', slug)
  git(repo, 'worktree', 'add', '-q', '-b', branch, path)
  return path
}

function commitIn(worktree: string, file: string): void {
  writeFileSync(join(worktree, file), `${file}\n`)
  git(worktree, 'add', file)
  git(worktree, 'commit', '-q', '-m', `add ${file}`)
}

const branches = (repo: string) => git(repo, 'branch', '--format=%(refname:short)').split('\n')

function hostWith(bound: [string, string][] = [], taskFolders: () => TaskFolderRecord[] = () => [], busy: string[] = bound.map(([sessionId]) => sessionId)): import('@solus/server/git/managed-worktrees').ManagedWorktreeHost {
  return {
    boundDirectories: () => bound,
    isSessionBusy: (sessionId) => busy.includes(sessionId),
    sessionTitles: async (ids) => new Map(ids.map((id) => [id, `Title of ${id}`])),
    taskFolders,
    codebaseName: async (id) => (id === 'cb1' ? 'Platform' : null),
  }
}

describe('managed worktrees in Settings', () => {
  test('lists only the worktrees Solus made, once for each repository', async () => {
    // WHY: Settings offers Delete on each row. A worktree the person made by
    // hand, or the project folder itself, must never be in that list.
    const repo = makeRepo()
    const ours = addManaged(repo, 'fix-login', 'solus/fix-login')
    git(repo, 'worktree', 'add', '-q', '-b', 'by-hand', join(root, `by-hand-${repoCount}`))
    mkdirSync(join(ours, 'src'))

    const listed = await managed.listManagedWorktrees([repo, repo], hostWith([['s1', join(ours, 'src')]]))

    expect(listed.map((each) => each.path)).toEqual([ours])
    expect(listed[0]).toMatchObject({
      kind: 'worktree',
      group: { key: `project:${repo}`, name: repo.split('/').pop() },
      title: 'solus/fix-login',
      hasUncommittedWork: false,
      hasUnmergedCommits: false,
    })
    // A session in a folder inside the worktree uses it too.
    expect(listed[0].sessions).toEqual([{ sessionId: 's1', title: 'Title of s1', isBusy: true }])
    expect(listed[0].sessionId).toBe('s1')
  })

  test('a branch has unmerged commits until its work is in main or pushed', async () => {
    // WHY: Delete also deletes the branch. A commit that is only on it is lost,
    // so the row must say so; a squash into main or a push keeps the work.
    const repo = makeRepo()
    const remote = join(root, `remote-${repoCount}.git`)
    git(root, 'init', '-q', '--bare', remote)
    git(repo, 'remote', 'add', 'origin', remote)
    const path = addManaged(repo, 'feature', 'solus/feature')
    commitIn(path, 'feature.txt')
    const unmerged = async () => (await managed.listManagedWorktrees([repo], hostWith()))[0].hasUnmergedCommits

    expect(await unmerged()).toBe(true)
    git(path, 'push', '-q', 'origin', 'solus/feature')
    expect(await unmerged()).toBe(false)

    commitIn(path, 'more.txt')
    expect(await unmerged()).toBe(true)
    // The same changes, as new commits on main: `git cherry` finds them merged.
    git(repo, 'cherry-pick', 'main..solus/feature')
    expect(await unmerged()).toBe(false)
  })

  test('removes a clean worktree and its branch', async () => {
    const repo = makeRepo()
    const path = addManaged(repo, 'done', 'solus/done')

    expect(await managed.removeManagedWorktree(path, { force: false }, hostWith())).toEqual({ status: 'removed' })
    expect(existsSync(path)).toBe(false)
    expect(branches(repo)).not.toContain('solus/done')
  })

  test('keeps a worktree with unsaved work until the person confirms', async () => {
    // WHY: the person confirms the loss of work; the host checks again, so
    // work made after the list loaded is not lost without that question.
    const repo = makeRepo()
    const path = addManaged(repo, 'dirty', 'solus/dirty')
    writeFileSync(join(path, 'notes.txt'), 'draft\n')

    expect(await managed.removeManagedWorktree(path, { force: false }, hostWith()))
      .toEqual({ status: 'unsaved', hasUncommittedWork: true, hasUnmergedCommits: false })
    expect(existsSync(path)).toBe(true)

    expect(await managed.removeManagedWorktree(path, { force: true }, hostWith())).toEqual({ status: 'removed' })
    expect(existsSync(path)).toBe(false)
    expect(branches(repo)).not.toContain('solus/dirty')
  })

  test('keeps a branch with unmerged commits until the person confirms', async () => {
    const repo = makeRepo()
    const path = addManaged(repo, 'commits', 'solus/commits')
    commitIn(path, 'work.txt')

    expect(await managed.removeManagedWorktree(path, { force: false }, hostWith()))
      .toEqual({ status: 'unsaved', hasUncommittedWork: false, hasUnmergedCommits: true })
    expect(branches(repo)).toContain('solus/commits')
  })

  test('refuses a worktree where a turn runs, also with force', async () => {
    const repo = makeRepo()
    const path = addManaged(repo, 'busy', 'solus/busy')

    const result = await managed.removeManagedWorktree(path, { force: true }, hostWith([['s2', path]]))

    expect(result).toEqual({ status: 'in_use', sessions: [{ sessionId: 's2', title: 'Title of s2', isBusy: true }] })
    expect(existsSync(path)).toBe(true)
  })

  test('removes a worktree whose session is open but idle', async () => {
    // WHY: a session stays bound to its folder while a tab shows it. Only a
    // running turn needs the folder; an idle session must not block cleanup.
    const repo = makeRepo()
    const path = addManaged(repo, 'idle', 'solus/idle')

    expect(await managed.removeManagedWorktree(path, { force: false }, hostWith([['s3', path]], () => [], []))).toEqual({ status: 'removed' })
    expect(existsSync(path)).toBe(false)
  })

  test('refuses a path that is not a managed worktree', async () => {
    // WHY: the RPC takes a path from a client. Only a worktree inside
    // `.git/solus/worktrees/` that git knows, or a known task folder, may be removed.
    const repo = makeRepo()
    const byHand = join(root, `by-hand-${repoCount}`)
    git(repo, 'worktree', 'add', '-q', '-b', 'by-hand', byHand)

    expect((await managed.removeManagedWorktree(byHand, { force: true }, hostWith())).status).toBe('failed')
    expect((await managed.removeManagedWorktree(join(repo, '.git', 'solus', 'worktrees', 'nothing'), { force: true }, hostWith())).status).toBe('failed')
    expect(existsSync(byHand)).toBe(true)
  })

  test('keeps the default branch of the project', async () => {
    const repo = makeRepo()
    git(repo, 'checkout', '-q', '-b', 'other')
    const path = join(repo, '.git', 'solus', 'worktrees', 'on-main')
    git(repo, 'worktree', 'add', '-q', path, 'main')

    expect(await managed.removeManagedWorktree(path, { force: false }, hostWith())).toEqual({ status: 'removed' })
    expect(branches(repo)).toContain('main')
  })
})

describe('task folders in Settings', () => {
  /** A task folder of two repositories of the codebase `cb1`, made for the session `s9`. */
  function makeTaskFolder(): { record: TaskFolderRecord; api: string; web: string } {
    const api = makeRepo(`api-${++repoCount}`)
    const web = makeRepo(`web-${repoCount}`)
    const folder = join(root, 'solus-task-folders', `platform-add-auth-${String(repoCount).padStart(8, '0')}`)
    mkdirSync(folder, { recursive: true })
    git(api, 'worktree', 'add', '-q', '-b', 'solus/add-auth', join(folder, 'api'))
    git(web, 'worktree', 'add', '-q', '-b', 'solus/add-auth', join(folder, 'web'))
    const record: TaskFolderRecord = {
      root: folder, anchor: root, primaryPath: join(folder, 'api'), primaryRepositoryPath: api, primaryIsWorktree: true,
      branch: 'solus/add-auth', repositories: [{ repositoryPath: web, worktreePath: join(folder, 'web'), name: 'web' }],
      codebaseId: 'cb1', sessionId: 's9', createdAt: 1,
    }
    taskFolderStore.putTaskFolder(record)
    return { record, api, web }
  }

  test('is one row under its codebase, named by its session', async () => {
    // WHY: a task folder is one piece of work. Deleting one of its worktrees
    // would leave the others on a branch that no session uses.
    const { record } = makeTaskFolder()
    const listed = await managed.listManagedWorktrees([], hostWith([], taskFolderStore.listTaskFolders))
    const row = listed.find((each) => each.path === record.root)

    expect(row).toMatchObject({ kind: 'task_folder', title: 'Title of s9', branch: 'solus/add-auth', group: { key: 'codebase:cb1', name: 'Platform' } })
    expect(row?.group.detail).toMatch(/^api-\d+ \+ web-\d+$/)
  })

  test('removes all its worktrees, its branch in each repository, and its record', async () => {
    const { record, api, web } = makeTaskFolder()
    commitIn(join(record.root, 'web'), 'login.ts')
    const host = hostWith([], taskFolderStore.listTaskFolders)

    // A commit only on the branch in one repository is unsaved work of the whole folder.
    expect(await managed.removeManagedWorktree(record.root, { force: false }, host))
      .toEqual({ status: 'unsaved', hasUncommittedWork: false, hasUnmergedCommits: true })
    expect(await managed.removeManagedWorktree(record.root, { force: true }, host)).toEqual({ status: 'removed' })

    expect(existsSync(record.root)).toBe(false)
    expect(branches(api)).not.toContain('solus/add-auth')
    expect(branches(web)).not.toContain('solus/add-auth')
    expect(taskFolderStore.listTaskFolders().some((each) => each.root === record.root)).toBe(false)
  })

  test('measures the size of a task folder, and of nothing else', async () => {
    const { record } = makeTaskFolder()
    const host = hostWith([], taskFolderStore.listTaskFolders)

    const [folder, other] = await managed.managedWorktreeSizes([record.root, root], host)

    expect(folder.bytes).toBeGreaterThan(0)
    expect(other).toEqual({ path: root, bytes: null })
  })
})

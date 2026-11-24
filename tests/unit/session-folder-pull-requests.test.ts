import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'
import type { PullRequest, RepoRef } from '@solus/contracts/providers'
import { PullRequestHead } from '@solus/contracts/repository-key'
import { pullRequestFixture } from './__fixtures__/pull-request'
import type { Provider } from '@solus/server/providers/types'

/**
 * Pull request detection for the session folders of a session
 * (docs/plans/codebases.md §8). The agent can open a pull request with `gh`
 * in any repository it works in. PR sync finds it by the branch of that
 * session folder. A codebase can cover many repositories, so a folder that the
 * session did not change is never looked up on the code host.
 */

mock.module('node:sqlite', () => ({ DatabaseSync }))

const providers = new Map<string, Provider>()
mock.module('@solus/server/providers/registry', () => ({
  providerForRepo: (repo: RepoRef) => providers.get(repo.repo) ?? null,
}))

let dataDir: string
let root: string
let PrSync: typeof import('@solus/server/prs/pr-sync')['PrSync']
let interest: typeof import('@solus/server/prs/pr-sync-interest')
let checkpoints: typeof import('@solus/server/git/turn-checkpoints')
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-folder-prs-'))
  root = realpathSync(mkdtempSync(join(tmpdir(), 'solus-folder-prs-repos-')))
  process.env.SOLUS_DATA_DIR = dataDir
  ;({ PrSync } = await import('@solus/server/prs/pr-sync'))
  interest = await import('@solus/server/prs/pr-sync-interest')
  checkpoints = await import('@solus/server/git/turn-checkpoints')
  // The helpers under test start processes; with no caller, they act as the host (plans/019).
  ;(await import('@solus/server/execution/seats/acting-identity')).actAsHostForTests()
})

afterAll(async () => {
  (await import('@solus/server/db')).closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`)
}

function createRepo(name: string): string {
  const cwd = join(root, name)
  mkdirSync(cwd)
  git(cwd, ['init', '-b', 'main'])
  git(cwd, ['config', 'user.email', 'test@example.com'])
  git(cwd, ['config', 'user.name', 'Test'])
  writeFileSync(join(cwd, 'tracked.txt'), 'first\n')
  git(cwd, ['add', '.'])
  git(cwd, ['commit', '-m', 'base'])
  git(cwd, ['checkout', '-b', 'fix-login'])
  return cwd
}

/** A code host for one repository. It counts each lookup by branch: the cost is part of what is tested. */
function codeHost(name: string) {
  const baseRepo = { host: 'github.com', owner: 'owner', repo: name }
  const host = { known: new Map<number, PullRequest>(), branchLookups: [] as string[][] }
  providers.set(name, { review: {
    getPullRequestsByHead: async (_repo: RepoRef, heads: PullRequestHead[]) => {
      host.branchLookups.push(heads.map((head) => head.branch))
      return new Map(heads.map((head) => [head.key, [...host.known.values()].filter((row) => head.isHeadOf(row))]))
    },
    getPullRequests: async (_repo: RepoRef, numbers: number[]) => new Map(numbers.map((number) => [number, host.known.get(number) ?? null])),
  } } as unknown as Provider)
  const pullRequest = (number: number, headRef: string) => pullRequestFixture(number, {
    baseRepo, headRef, headRepo: { owner: 'owner', repo: name, isFork: false }, url: `https://github.com/owner/${name}/pull/${number}`,
  })
  return { repo: baseRepo, host, pullRequest }
}

describe('pull request detection in session folders', () => {
  test('finds the pull request on the branch of a changed session folder, and does not look up a folder the session left alone', async () => {
    const sessionId = 'folders-session'
    const [app, api, web] = ['app', 'api', 'web'].map(createRepo)
    const hosts = new Map([[app, codeHost('folders-app')], [api, codeHost('folders-api')], [web, codeHost('folders-web')]])
    hosts.get(api)!.host.known.set(5, hosts.get(api)!.pullRequest(5, 'fix-login'))
    // A pull request on the same branch name in the repository the session only reads: it is not the session's.
    hosts.get(web)!.host.known.set(6, hosts.get(web)!.pullRequest(6, 'fix-login'))

    // One turn of the session changes `api` and leaves `web` alone.
    const folders = [api, web].map((path) => ({ path, repositoryPath: path, name: path }))
    const target = { sessionId, workTree: app, folders: () => folders }
    await checkpoints.beginTurnCheckpoint(target)
    writeFileSync(join(api, 'handler.ts'), 'export {}\n')
    await checkpoints.endTurnCheckpoint(target, { partial: false, userMessagePreview: 'fix the login' })

    const ofFolders = () => interest.sessionFolderCheckouts(folders.map((folder) => ({ sessionId, path: folder.path, repositoryPath: folder.repositoryPath, branch: 'fix-login' })))
    expect(ofFolders()).toEqual([{ projectScope: api, branch: 'fix-login', sessionId }])

    const sync = new PrSync({
      publish: () => {},
      liveCheckouts: (now, ofLiveTasks) => interest.liveCheckouts(now, ofLiveTasks, ofFolders()),
      codeHost: async (scope) => {
        const found = hosts.get(scope)
        return found ? { repo: found.repo, provider: providers.get(found.repo.repo)! } : null
      },
      pushHead: async (host, _scope, branch) => new PullRequestHead(host.repo, branch),
      defaultBranch: async () => 'main',
      sessionCheckout: () => null,
    })
    await sync.turnEnded(sessionId)
    await sync.tick()

    const sessionPrs = await import('@solus/server/data/sessions/session-pull-requests')
    const links = (await sessionPrs.readSessionPullRequests('local', [sessionId]))[sessionId] ?? []
    expect(links.map((link) => [link.repository, link.number, link.source])).toEqual([['github.com/owner/folders-api', 5, 'branch']])
    expect(hosts.get(api)!.host.branchLookups).toEqual([['fix-login']])
    expect(hosts.get(web)!.host.branchLookups).toEqual([])
  })

  // WHY: a task folder gives each repository a worktree on the session's
  // branch. The agent can push that branch and open a pull request with no
  // file change in a turn that a checkpoint records, so the worktree counts.
  test('a worktree that stands in for a repository is looked up also before a turn changed it', () => {
    const checkouts = interest.sessionFolderCheckouts([
      { sessionId: 's', path: '/data/solus-task-folders/fix-1a2b/api', repositoryPath: '/work/api', branch: 'fix' },
      { sessionId: 's', path: '/work/web', repositoryPath: '/work/web', branch: 'fix' },
      { sessionId: 's', path: '/data/solus-task-folders/fix-1a2b/docs', repositoryPath: '/work/docs', branch: null },
    ], () => false)
    expect(checkouts).toEqual([{ projectScope: '/work/api', branch: 'fix', sessionId: 's' }])
  })
})

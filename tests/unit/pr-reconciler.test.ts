import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { PullRequest, RepoRef } from '@solus/contracts/providers'
import type { Provider } from '@solus/server/providers/types'

/**
 * Noticing a merge Solus did not make.
 *
 * Every in-Solus write announces itself, so the only pull requests that go
 * stale are the ones changed elsewhere — on github.com, through `gh`, or from
 * another machine. These tests pin the rule: a linked pull request the host no
 * longer reports open is news exactly once, and a merge also completes the work
 * that was waiting on it.
 *
 * Each test names its own repository. `PrIndex` is a process-wide cache of
 * answers *and* of the code host each pull request was first read through, so
 * tests sharing a repository would be reading each other's fixtures.
 */

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

let dataDir: string
let taskStore: typeof import('@solus/server/tasks/task-store')
let tasks: typeof import('@solus/server/tasks/task')
let PrReconciler: typeof import('@solus/server/prs/pr-reconciler')['PrReconciler']
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-pr-reconciler-'))
  process.env.SOLUS_DATA_DIR = dataDir
  taskStore = await import('@solus/server/tasks/task-store')
  tasks = await import('@solus/server/tasks/task')
  ;({ PrReconciler } = await import('@solus/server/prs/pr-reconciler'))
})

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

interface Announcement {
  projectRoot: string
  detail: PullRequest
}

/** A project, a task waiting on pull request #1, and a code host that answers
 *  with whatever the test last said — counting what it was asked, because the
 *  poll's cost is part of what these tests pin. */
async function project(name: string, status: 'in_review' | 'todo' = 'in_review') {
  const projectScope = join(dataDir, name)
  const repo: RepoRef = { host: 'github.com', owner: 'owner', repo: name }
  const created = await taskStore.createTask({ title: 'Work on #1', status: 'todo', projectKey: projectScope })
  const task = await tasks.Task.byId(created.id)
  await task.update({ status })
  // With the URL supplied, linking stays local: resolving one is a code-host
  // round trip, and these tests are about the poll, not about linking.
  await task.linkPullRequest({
    number: 1,
    targetScope: projectScope,
    url: 'https://github.com/owner/repo/pull/1',
  })

  const announced: Announcement[] = []
  const host = { reads: 0, state: 'open' as PullRequest['state'] }
  const provider = {
    // SAFETY: the reconciler reaches the host through `PrIndex`, which reads a
    // pull request with this one method.
    review: {
      getPullRequest: async (_repo: RepoRef, number: number): Promise<PullRequest> => {
        host.reads += 1
        return { number, state: host.state, draft: false, headSha: 'sha-1', headRef: 'feature' } as unknown as PullRequest
      },
    },
  } as unknown as Provider

  return {
    projectScope,
    task,
    announced,
    host,
    reconciler: new PrReconciler({
      announce: (projectRoot, detail) => { announced.push({ projectRoot, detail }) },
      codeHost: async () => ({ repo, provider }),
      watchList: () => [{ projectScope, number: 1 }],
    }),
  }
}

describe('reconciling pull requests changed outside Solus', () => {
  test('announces a merge made on the code host and completes the task waiting on it', async () => {
    const { projectScope, task, announced, host, reconciler } = await project('merged-elsewhere')

    // An open pull request is what every surface would read for itself.
    await reconciler.poll()
    expect(announced).toEqual([])

    host.state = 'merged'
    await reconciler.poll()

    expect(announced).toHaveLength(1)
    expect(announced[0]?.projectRoot).toBe(projectScope)
    expect(announced[0]?.detail.state).toBe('merged')
    expect((await tasks.Task.byId(task.id)).status).toBe('done')
  })

  test('reports a settled pull request once, then stops asking', async () => {
    // WHY: this is both the correctness rule and the cost model. A merged pull
    // request cannot change again, so a repository whose linked work is
    // finished must cost no requests at all.
    const { announced, host, reconciler } = await project('settled', 'todo')
    host.state = 'closed'

    await reconciler.poll()
    await reconciler.poll()

    expect(announced).toHaveLength(1)
    expect(host.reads).toBe(1)
  })

  test('watches the pull requests of work that is still going, and no others', async () => {
    // WHY: a pull request nobody's task points at has no Solus surface to go
    // stale, and a task that is done has stopped asking what became of its
    // pull request. This query is what keeps the poll small.
    const db = await import('@solus/server/db')
    const links = await import('@solus/server/tasks/task-links')
    const going = await project('watch-list-active', 'in_review')
    const finished = await project('watch-list-finished', 'todo')
    await (await tasks.Task.byId(finished.task.id)).update({ status: 'done' })

    const watched = links.readActivePrLinkTargets(db.getDb())

    expect(watched).toContainEqual({ projectScope: going.projectScope, number: 1 })
    expect(watched).not.toContainEqual({ projectScope: finished.projectScope, number: 1 })
  })
})

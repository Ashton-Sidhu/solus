import { describe, expect, test } from 'bun:test'
import type { TaskProjectSources, TaskSessionLink, TaskSidebarPrLink, TaskSourceState } from '@solus/contracts/task-types'
import {
  hostOfSessionLink,
  mergePrLinks,
  mergeProjectSources,
  mergeSessionLinks,
  tasksInSources,
} from '@solus/workspace-ui/contexts/tasks/task-projects'

const REPO = 'github-repo:acme/app'
const BOARD = 'github-project:acme/7'
const JIRA = 'jira-project:cloud-1/SOL'

function source(sourceKey: string, overrides: Partial<TaskSourceState> = {}): TaskSourceState {
  return {
    sourceKey,
    source: { kind: 'github-repo', owner: 'acme', repo: 'app' },
    label: sourceKey,
    columns: [],
    health: 'ok',
    ...overrides,
  }
}

function link(sessionId: string, linkedAt: number, sessionTitle: string | null = null): TaskSessionLink {
  return { sessionId, sessionTitle, provider: 'claude-code', model: null, startedAt: null, lastActivityAt: null, linkedAt }
}

describe('which tasks a project shows', () => {
  const tasks = [
    { id: 'repo', placements: [{ sourceKey: REPO, columnId: 'open' }] },
    { id: 'repo-and-board', placements: [{ sourceKey: REPO, columnId: 'open' }, { sourceKey: BOARD, columnId: null }] },
    { id: 'jira', placements: [{ sourceKey: JIRA, columnId: '1' }] },
    { id: 'no-source', placements: [] },
  ]

  test('a project shows the tasks whose placements name one of its sources', () => {
    // WHY: a task belongs to no project by itself (plan §4.2). The project
    // config lists sources, and the placement is the only link between them.
    expect(tasksInSources(tasks, new Set([BOARD])).map((task) => task.id)).toEqual(['repo-and-board'])
    expect(tasksInSources(tasks, new Set([JIRA, BOARD])).map((task) => task.id)).toEqual(['repo-and-board', 'jira'])
  })

  test('a task in two sources of one project shows once', () => {
    // WHY: an issue on the repository and on the board of one project is one
    // task (decision 10). Two rows would break the keyed list.
    expect(tasksInSources(tasks, new Set([REPO, BOARD])).map((task) => task.id)).toEqual(['repo', 'repo-and-board'])
  })

  test('a project with no task source has no tasks', () => {
    // WHY: decision 11. Without the guard, a task with no placement would not
    // match either, but the rule must hold for every task.
    expect(tasksInSources(tasks, new Set())).toEqual([])
  })
})

describe('the sources of one project across its checkouts', () => {
  test('each source shows once, as the provider answered it most recently', () => {
    // WHY: two checkouts of one repository list the same source, and each
    // host reports its own read. A person wants the freshest label, columns
    // and health, not the answer of whichever host is first.
    const laptop: TaskProjectSources = { sources: [source(REPO, { fetchedAt: 100, label: 'old name' }), source(BOARD, { fetchedAt: 300 })] }
    const workshop: TaskProjectSources = { sources: [source(REPO, { fetchedAt: 200, label: 'new name', health: 'reconnect' })] }

    const merged = mergeProjectSources([laptop, workshop])

    expect(merged.map((state) => state.sourceKey)).toEqual([REPO, BOARD])
    expect(merged[0]).toMatchObject({ label: 'new name', health: 'reconnect', fetchedAt: 200 })
    // The order of the answers does not decide.
    expect(mergeProjectSources([workshop, laptop]).find((state) => state.sourceKey === REPO)?.label).toBe('new name')
  })

  test('a read that the provider answered beats a source that was never read', () => {
    // WHY: a host that just learned of a source has no columns yet. Its empty
    // state must not replace the columns that another host already read.
    const neverRead: TaskProjectSources = { sources: [source(REPO, { label: 'never read' })] }
    const read: TaskProjectSources = { sources: [source(REPO, { fetchedAt: 1, label: 'read' })] }

    expect(mergeProjectSources([neverRead, read])[0].label).toBe('read')
    expect(mergeProjectSources([read, neverRead])[0].label).toBe('read')
  })
})

describe('session links of one task key from more than one host', () => {
  test('the links of the project host and of the Solus API become one list, newest first', () => {
    // WHY: a client reads attachments from each host that answers (plan §7).
    // A cloud session files its link with the organization's Solus API; a
    // local session files with the project host. The task shows both.
    const merged = mergeSessionLinks(new Map([
      ['workshop', [link('local-run', 10)]],
      ['cloud', [link('cloud-run', 30), link('older-cloud-run', 5)]],
    ]), ['workshop', 'cloud'])

    expect(merged.map((held) => held.sessionId)).toEqual(['cloud-run', 'local-run', 'older-cloud-run'])
  })

  test('a session that two hosts hold shows once, as the first host in the order holds it', () => {
    // WHY: a dispatched session can be linked on both hosts. Two rows for one
    // session would offer the same conversation twice.
    const merged = mergeSessionLinks(new Map([
      ['cloud', [link('shared', 20, 'Title on the Solus API')]],
      ['workshop', [link('shared', 10, 'Title on the project host')]],
    ]), ['workshop', 'cloud'])

    expect(merged).toHaveLength(1)
    expect(merged[0].sessionTitle).toBe('Title on the project host')
  })

  test('the list is the same whichever host answered first', () => {
    // WHY: hosts answer in any order. If the later answer won, a link would
    // change its title and its place each time the second host answered.
    const fromWorkshop = [link('shared', 10, 'Title on the project host')]
    const fromCloud = [link('shared', 20, 'Title on the Solus API'), link('cloud-only', 5)]
    const workshopFirst = new Map([['workshop', fromWorkshop]])
    const beforeCloud = mergeSessionLinks(workshopFirst, ['workshop', 'cloud'])
    workshopFirst.set('cloud', fromCloud)
    const cloudFirst = new Map([['cloud', fromCloud], ['workshop', fromWorkshop]])

    expect(mergeSessionLinks(workshopFirst, ['workshop', 'cloud'])).toEqual(mergeSessionLinks(cloudFirst, ['workshop', 'cloud']))
    // The link that the first host held is the same object after the second host answers.
    expect(mergeSessionLinks(workshopFirst, ['workshop', 'cloud']).find((held) => held.sessionId === 'shared')).toBe(beforeCloud[0])
  })

  test('a host that the order does not name comes after the hosts it names', () => {
    // WHY: a host can hold a link before this client lists it in the catalog.
    // Its links still show; a known host still wins a shared session.
    const merged = mergeSessionLinks(new Map([
      ['unlisted', [link('shared', 1, 'From the unlisted host'), link('unlisted-only', 2)]],
      ['workshop', [link('shared', 1, 'From the project host')]],
    ]), ['workshop'])

    expect(merged.map((held) => held.sessionTitle ?? held.sessionId)).toEqual(['unlisted-only', 'From the project host'])
  })

  test('an unlink goes to the host that holds the link', () => {
    // WHY: another host does not know the link, so an unlink sent there
    // changes nothing and the link comes back with the next snapshot.
    const linksByHost = new Map([
      ['workshop', [link('local-run', 1), link('shared', 1)]],
      ['cloud', [link('cloud-run', 1), link('shared', 1)]],
    ])
    const order = ['workshop', 'cloud']

    expect(hostOfSessionLink(linksByHost, order, 'cloud-run')).toBe('cloud')
    expect(hostOfSessionLink(linksByHost, order, 'local-run')).toBe('workshop')
    // The same host whose copy the merged list shows.
    expect(hostOfSessionLink(linksByHost, order, 'shared')).toBe('workshop')
    expect(hostOfSessionLink(linksByHost, order, 'not-linked')).toBeUndefined()
  })
})

describe('pull request links from more than one host', () => {
  const pr = (number: number, targetScope: string | undefined, title: string): TaskSidebarPrLink => ({ number, targetScope, title })

  test('one pull request is one repository and one number', () => {
    // WHY: two hosts can hold the link to the same pull request, and #12 of
    // one repository is not #12 of another.
    const merged = mergePrLinks(new Map([
      ['workshop', [pr(12, 'github.com/acme/app', 'From the project host')]],
      ['cloud', [pr(12, 'github.com/acme/app', 'From the Solus API'), pr(12, 'github.com/acme/site', 'Other repository')]],
    ]), ['workshop', 'cloud'])

    expect(merged.map((held) => held.title)).toEqual(['From the project host', 'Other repository'])
  })

  test('the links of the first host in the order lead, so the newest link of the reader stays first', () => {
    // WHY: `prLinks[0]` is the pull request a row shows. It must not change
    // when a second host answers.
    const linksByHost = new Map([
      ['cloud', [pr(40, 'github.com/acme/app', 'cloud')]],
      ['workshop', [pr(41, 'github.com/acme/app', 'workshop')]],
    ])
    expect(mergePrLinks(linksByHost, ['workshop', 'cloud']).map((held) => held.number)).toEqual([41, 40])
  })
})

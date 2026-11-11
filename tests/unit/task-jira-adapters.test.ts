import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { taskKey } from '@solus/contracts/task-sources'
import type { TaskSource } from '@solus/contracts/task-sources'
import type { JiraTransport, SourceWriteState, TaskHome } from '@solus/server/data/tasks/providers/types'
import { DatabaseSync } from './helpers/bun-sqlite'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync }))

const { JiraTaskProvider } = await import('@solus/server/data/tasks/providers/jira')
const { JiraProjectSource } = await import('@solus/server/data/tasks/sources/jira-project')
const { JiraBoardSource } = await import('@solus/server/data/tasks/sources/jira-board')
const { JiraRequestError, TaskProviderError, MAX_SOURCE_TASKS } = await import('@solus/server/data/tasks/providers/types')

// Jira owns each task. The workflow makes this adapter more than a field map:
// Jira has no "set the status" write, only the transitions the current status
// permits. These tests pin what Solus reads and what it sends, with recorded
// answer shapes and no network.

type JiraRequest = Parameters<JiraTransport['request']>[0]

const CLOUD_ID = 'cloud-1'
const SITE_URL = 'https://acme.atlassian.net'
const HOME: TaskHome = { provider: 'jira', cloudId: CLOUD_ID, key: 'ACME-7' }
const PROJECT_SOURCE: TaskSource = { kind: 'jira-project', cloudId: CLOUD_ID, projectKey: 'ACME' }
const BOARD_SOURCE: TaskSource = { kind: 'jira-board', cloudId: CLOUD_ID, boardId: 12 }
const BOARD_WRITE_STATE: SourceWriteState = {
  kind: 'jira-board',
  projectKey: 'ACME',
  columns: [
    { columnId: 'To Do', statusIds: ['1'] },
    { columnId: 'Doing', statusIds: ['3', '4'] },
    { columnId: 'Done', statusIds: ['5'] },
    { columnId: 'Parked', statusIds: [] },
  ],
}

const STATUS = {
  todo: { id: '1', name: 'To Do', statusCategory: { key: 'new' } },
  building: { id: '3', name: 'Building', statusCategory: { key: 'indeterminate' } },
  review: { id: '4', name: 'In Review', statusCategory: { key: 'indeterminate' } },
  done: { id: '5', name: 'Done', statusCategory: { key: 'done' } },
}

function doc(text: string) {
  return { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }
}

interface IssueOverrides {
  id?: string
  key?: string
  status?: typeof STATUS.todo
  parent?: { key: string; fields: { summary: string } } | null
  commentTotal?: number
}

/** An issue as `/rest/api/3/issue/{id}` and the searches answer it. */
function issuePayload(overrides: IssueOverrides = {}) {
  return {
    id: overrides.id ?? '10007',
    key: overrides.key ?? 'ACME-7',
    fields: {
      summary: 'Ship the thing',
      description: doc('Body text'),
      created: '2026-07-30T10:00:00.000+0000',
      updated: '2026-08-01T10:00:00.000+0000',
      labels: ['infra'],
      status: overrides.status ?? STATUS.todo,
      priority: { name: 'Highest' },
      assignee: { displayName: 'Ada Lovelace', avatarUrls: { '48x48': 'https://avatars/ada' } },
      parent: overrides.parent ?? null,
      comment: {
        total: overrides.commentTotal ?? 1,
        comments: [{ id: '9001', author: { displayName: 'Grace' }, body: doc('Looks good'), created: '2026-08-01T09:00:00.000+0000' }],
      },
    },
  }
}

const TRANSITIONS = [
  { id: '21', name: 'Start', to: STATUS.building },
  { id: '31', name: 'Send to review', to: STATUS.review },
  { id: '41', name: 'Finish', to: STATUS.done },
]

/** A `JiraTransport` that answers by path. Each call is recorded and each
 *  answer is parsed with the adapter's own schema, as the real transport does. */
function fakeJira(answer: (request: JiraRequest) => unknown, siteUrl: string | null = SITE_URL) {
  const requests: JiraRequest[] = []
  const jira: JiraTransport = {
    request: async <Schema extends z.ZodType>(request: JiraRequest, schema: Schema): Promise<z.infer<Schema>> => {
      requests.push(request)
      return schema.parse(await answer(request))
    },
    siteUrl: () => Promise.resolve(siteUrl),
  }
  return { jira, requests }
}

/** One issue with a workflow: reads give the issue, `/transitions` gives the legal transitions. */
function issueAnswers(options: { transitions?: typeof TRANSITIONS; issue?: IssueOverrides } = {}) {
  return (request: JiraRequest): unknown => {
    if (request.path.endsWith('/transitions')) {
      return request.method === 'POST' ? undefined : { transitions: options.transitions ?? TRANSITIONS }
    }
    if (request.method === 'PUT') return undefined
    return issuePayload(options.issue)
  }
}

function transitionPosts(requests: JiraRequest[]): JiraRequest[] {
  return requests.filter((request) => request.method === 'POST' && request.path.endsWith('/transitions'))
}

const jqlBodySchema = z.object({ jql: z.string(), fields: z.array(z.string()) })

describe('the identity of a Jira task', () => {
  test('a task is named by the numeric issue id and shown by its key', async () => {
    // WHY: Jira changes the key when an issue moves to another project. The
    // numeric id stays, so the task key stays.
    const { jira, requests } = fakeJira(() => issuePayload())

    const { task } = await new JiraTaskProvider(jira).fetch({ provider: 'jira', cloudId: CLOUD_ID, id: '10007' })

    expect(requests[0]?.path).toBe('/rest/api/3/issue/10007')
    expect(taskKey(task.ref)).toBe('jira:cloud-1:10007')
    expect(task.reference).toBe('ACME-7')
    expect(task.home).toEqual(HOME)
    // The link addresses the site, not the API gateway, which needs a bearer token.
    expect(task.url).toBe('https://acme.atlassian.net/browse/ACME-7')
  })

  test('reads the state in Jira words, with the category Jira gives and the status id', async () => {
    const { jira } = fakeJira(() => issuePayload({ status: STATUS.review }))
    const { task } = await new JiraTaskProvider(jira).fetch({ provider: 'jira', cloudId: CLOUD_ID, id: '10007' })
    expect(task.state).toEqual({ name: 'In Review', category: 'active' })
    expect(task.stateId).toBe('4')
    expect(task).toMatchObject({
      title: 'Ship the thing',
      body: 'Body text',
      priority: 'urgent',
      labels: ['infra'],
      assignee: 'Ada Lovelace',
      assigneeAvatarUrl: 'https://avatars/ada',
      writableFields: ['title', 'body', 'labels', 'priority'],
      updatedAt: Date.parse('2026-08-01T10:00:00.000+0000'),
    })
  })

  test('a site that is not the connected one gives no link', async () => {
    // WHY: a link to a site where the person is not signed in only misleads.
    const { jira } = fakeJira(() => issuePayload(), null)
    const { task } = await new JiraTaskProvider(jira).fetch({ provider: 'jira', cloudId: CLOUD_ID, id: '10007' })
    expect(task.url).toBeNull()
  })

  test('the Jira provider refuses a GitHub task', async () => {
    const { jira, requests } = fakeJira(() => issuePayload())
    const provider = new JiraTaskProvider(jira)
    await expect(provider.fetch({ provider: 'github', id: 'I_1' })).rejects.toThrow(/github/i)
    await expect(provider.update({ provider: 'github', kind: 'issue', owner: 'a', repo: 'b', number: 1 }, { title: 'x' }))
      .rejects.toThrow(/github/i)
    expect(requests).toHaveLength(0)
  })
})

describe('reading one Jira issue', () => {
  test('gives the comments and says when the issue has more', async () => {
    const { jira } = fakeJira(() => issuePayload({ commentTotal: 40 }))
    const details = await new JiraTaskProvider(jira).fetch({ provider: 'jira', cloudId: CLOUD_ID, id: '10007' })
    expect(details.comments).toEqual([
      { id: '9001', author: 'Grace', body: 'Looks good', createdAt: Date.parse('2026-08-01T09:00:00.000+0000') },
    ])
    expect(details.commentsTruncated).toBe(true)
  })

  test('gives the parent as the epic, with the description from one more read', async () => {
    // WHY: the agent gets the description of the epic as context. The issue
    // answer names the parent but never has its description.
    const { jira, requests } = fakeJira((request) => {
      if (request.path === '/rest/api/3/issue/ACME-1') {
        return { fields: { summary: 'Release 2.0', description: doc('Every client in one week.') } }
      }
      return issuePayload({ parent: { key: 'ACME-1', fields: { summary: 'Release 2' } } })
    })

    const { task } = await new JiraTaskProvider(jira).fetch({ provider: 'jira', cloudId: CLOUD_ID, id: '10007' })

    expect(task.epic).toEqual({
      provider: 'jira',
      externalId: 'ACME-1',
      url: 'https://acme.atlassian.net/browse/ACME-1',
      title: 'Release 2.0',
      body: 'Every client in one week.',
    })
    expect(requests.map((request) => request.path)).toEqual(['/rest/api/3/issue/10007', '/rest/api/3/issue/ACME-1'])
  })

  test('an epic the person cannot read still names itself and does not fail the read', async () => {
    const { jira } = fakeJira((request) => {
      if (request.path === '/rest/api/3/issue/ACME-1') throw new JiraRequestError(403, 'You do not have permission to see this issue.')
      return issuePayload({ parent: { key: 'ACME-1', fields: { summary: 'Release 2' } } })
    })
    const { task } = await new JiraTaskProvider(jira).fetch({ provider: 'jira', cloudId: CLOUD_ID, id: '10007' })
    expect(task.epic).toMatchObject({ externalId: 'ACME-1', title: 'Release 2', body: '' })
  })

  test('an issue with no parent has no epic and reads nothing more', async () => {
    const { jira, requests } = fakeJira(() => issuePayload())
    const { task } = await new JiraTaskProvider(jira).fetch({ provider: 'jira', cloudId: CLOUD_ID, id: '10007' })
    expect(task.epic).toBeUndefined()
    expect(requests).toHaveLength(1)
  })
})

describe('writing to a Jira issue', () => {
  test('writes the fields and the priority in one issue update', async () => {
    const { jira, requests } = fakeJira(issueAnswers())
    await new JiraTaskProvider(jira).update(HOME, { title: 'New title', priority: 'urgent', labels: ['a'] })
    const update = requests.find((request) => request.method === 'PUT')
    expect(update?.path).toBe('/rest/api/3/issue/ACME-7')
    expect(update?.body).toEqual({ fields: { summary: 'New title', labels: ['a'], priority: { name: 'Highest' } } })
  })

  test('clears a priority the task no longer has', async () => {
    // WHY: a cleared priority must reach Jira as "none", not as "leave it".
    const { jira, requests } = fakeJira(issueAnswers())
    await new JiraTaskProvider(jira).update(HOME, { priority: null })
    expect(requests.find((request) => request.method === 'PUT')?.body).toEqual({ fields: { priority: null } })
  })

  test('refuses an assignee or a due date instead of ignoring it', async () => {
    // WHY: a silent success would show a value that Jira does not hold.
    const { jira, requests } = fakeJira(issueAnswers())
    const provider = new JiraTaskProvider(jira)
    await expect(provider.update(HOME, { assignee: 'ada' })).rejects.toThrow(/assignee or the due date/)
    await expect(provider.update(HOME, { title: 'x', dueDate: '2026-09-01' })).rejects.toThrow(/assignee or the due date/)
    expect(requests).toHaveLength(0)
  })

  test('setState makes a transition whose destination is in the category', async () => {
    const { jira, requests } = fakeJira(issueAnswers())
    const provider = new JiraTaskProvider(jira)

    await provider.setState(HOME, 'done')
    await provider.setState(HOME, 'active')

    expect(transitionPosts(requests).map((request) => request.body)).toEqual([
      { transition: { id: '41' } },
      { transition: { id: '21' } },
    ])
  })

  test('setState fails by name when no legal transition reaches the category', async () => {
    // WHY: a guess of a near state would put the issue where nobody asked, and
    // Solus would then show a status that Jira does not hold.
    const { jira, requests } = fakeJira(issueAnswers({ transitions: [TRANSITIONS[0]] }))
    await expect(new JiraTaskProvider(jira).setState(HOME, 'done'))
      .rejects.toThrow("No Jira transition from ACME-7's current status reaches done.")
    expect(transitionPosts(requests)).toHaveLength(0)
  })

  test('a comment goes to the issue as ADF and answers the Jira comment id', async () => {
    const { jira, requests } = fakeJira(() => ({
      id: '9002',
      author: { displayName: 'Ada' },
      body: doc('posted'),
      created: '2026-08-01T11:00:00.000+0000',
    }))
    const comment = await new JiraTaskProvider(jira).comment(HOME, 'posted')
    expect(requests[0]).toMatchObject({ method: 'POST', path: '/rest/api/3/issue/ACME-7/comment' })
    expect(comment).toEqual({ id: '9002', author: 'Ada', body: 'posted', createdAt: Date.parse('2026-08-01T11:00:00.000+0000') })
  })

  test('a Jira issue cannot be deleted', async () => {
    const { jira, requests } = fakeJira(() => undefined)
    await expect(new JiraTaskProvider(jira).remove(HOME)).rejects.toThrow('A Jira issue cannot be deleted from Solus.')
    expect(requests).toHaveLength(0)
  })
})

describe('a Jira project source', () => {
  function projectAnswers(request: JiraRequest): unknown {
    if (request.path === '/rest/api/3/project/ACME/statuses') {
      return [
        { name: 'Task', statuses: [STATUS.todo, STATUS.building, STATUS.done] },
        { name: 'Bug', statuses: [STATUS.todo, STATUS.review, STATUS.done] },
      ]
    }
    return { issues: [issuePayload({ status: STATUS.building, parent: { key: 'ACME-1', fields: { summary: 'Release 2' } } })] }
  }

  test('its columns are the statuses of the project, one time each, in the first-seen order', async () => {
    // WHY: Jira gives the statuses for each issue type, so a status of two
    // workflows comes two times. A person must see one column for it.
    const { jira, requests } = fakeJira(projectAnswers)

    const read = await new JiraProjectSource(jira).read(PROJECT_SOURCE)

    expect(read.label).toBe('ACME')
    expect(read.columns).toEqual([
      { id: '1', name: 'To Do', category: 'open' },
      { id: '3', name: 'Building', category: 'active' },
      { id: '5', name: 'Done', category: 'done' },
      { id: '4', name: 'In Review', category: 'active' },
    ])
    expect(read.writeState).toBeNull()
    expect(read.items).toHaveLength(1)
    expect(read.items[0]).toMatchObject({ columnId: '3', itemId: null })
    expect(taskKey(read.items[0]!.task.ref)).toBe('jira:cloud-1:10007')

    const search = jqlBodySchema.parse(requests.find((request) => request.path === '/rest/api/3/search/jql')?.body)
    expect(search.jql).toBe('project = "ACME" ORDER BY updated DESC')
    // A list does not show comments, so it does not ask for them.
    expect(search.fields).not.toContain('comment')
    // A list names the epic from the search answer alone.
    expect(read.items[0]?.task.epic).toMatchObject({ externalId: 'ACME-1', title: 'Release 2', body: '' })
    expect(requests.some((request) => request.path === '/rest/api/3/issue/ACME-1')).toBe(false)
  })

  test('stops at the cap and says that the project holds more', async () => {
    let page = 0
    const { jira } = fakeJira((request) => {
      if (request.path.endsWith('/statuses')) return []
      page += 1
      return {
        issues: Array.from({ length: 50 }, (_, index) => issuePayload({ id: `${page * 100 + index}`, key: `ACME-${page * 100 + index}` })),
        nextPageToken: `page-${page}`,
      }
    })

    const read = await new JiraProjectSource(jira).read(PROJECT_SOURCE)

    expect(read.items).toHaveLength(MAX_SOURCE_TASKS)
    expect(read.truncated).toBe(true)
    expect(page).toBe(4)
  })

  test('search sends the text to Jira, in the project, and escapes it', async () => {
    // WHY: a quote that is not escaped turns a search box into a JQL injection,
    // and a filter of the capped list does not find an older issue.
    const { jira, requests } = fakeJira(projectAnswers)
    await new JiraProjectSource(jira).search(PROJECT_SOURCE, 'say "hi"')
    const { jql } = jqlBodySchema.parse(requests[0]?.body)
    expect(jql).toBe('project = "ACME" AND (summary ~ "say \\"hi\\"" OR key = "say \\"hi\\"") ORDER BY updated DESC')
  })

  test('a move is the legal transition to the status of the column', async () => {
    const { jira, requests } = fakeJira(issueAnswers({ issue: { status: STATUS.review } }))

    const task = await new JiraProjectSource(jira).move({
      source: PROJECT_SOURCE,
      writeState: null,
      home: HOME,
      itemId: null,
      columnId: '4',
    })

    expect(transitionPosts(requests).map((request) => request.body)).toEqual([{ transition: { id: '31' } }])
    expect(task.stateId).toBe('4')
  })

  test('a move with no legal transition fails loudly and sends no transition', async () => {
    // WHY: the workflow decides what is legal. Solus must not put the issue
    // in a near status and then show a column that Jira does not hold.
    const { jira, requests } = fakeJira(issueAnswers({ transitions: [TRANSITIONS[0]] }))
    await expect(new JiraProjectSource(jira).move({
      source: PROJECT_SOURCE,
      writeState: null,
      home: HOME,
      itemId: null,
      columnId: '5',
    })).rejects.toThrow("No Jira transition from ACME-7's current status reaches status 5. Adjust the workflow or move the issue in Jira.")
    expect(transitionPosts(requests)).toHaveLength(0)
  })

  test('create uses the default issue type of the project, never a subtask', async () => {
    // WHY: a subtask cannot be without a parent, so the create would fail in
    // Jira with an error that nobody can act on.
    const { jira, requests } = fakeJira((request) => {
      if (request.path.includes('/issuetypes')) {
        return { issueTypes: [{ id: '10', name: 'Sub-task', subtask: true }, { id: '11', name: 'Task' }] }
      }
      if (request.path === '/rest/api/3/issue' && request.method === 'POST') return { id: '10008', key: 'ACME-8' }
      return issueAnswers({ issue: { id: '10008', key: 'ACME-8' } })(request)
    })

    const item = await new JiraProjectSource(jira).create({
      source: PROJECT_SOURCE,
      writeState: null,
      // The workflow starts in To Do, so this column needs no transition.
      draft: { title: 'New work', priority: 'high', columnId: '1' },
    })

    const created = requests.find((request) => request.path === '/rest/api/3/issue')
    expect(created?.body).toMatchObject({
      fields: { project: { key: 'ACME' }, issuetype: { id: '11' }, summary: 'New work', priority: { name: 'High' } },
    })
    expect(item.task.reference).toBe('ACME-8')
    expect(item.columnId).toBe('1')
    expect(transitionPosts(requests)).toHaveLength(0)
  })

  test('refuses a source of another kind', async () => {
    const { jira, requests } = fakeJira(projectAnswers)
    await expect(new JiraProjectSource(jira).read(BOARD_SOURCE)).rejects.toThrow(/jira-board/)
    expect(requests).toHaveLength(0)
  })
})

describe('a Jira board source', () => {
  function boardAnswers(request: JiraRequest): unknown {
    if (request.path === '/rest/agile/1.0/board/12') return { id: 12, name: 'Launch sprint', location: { projectKey: 'ACME' } }
    if (request.path === '/rest/agile/1.0/board/12/configuration') {
      return {
        columnConfig: {
          columns: [
            { name: 'To Do', statuses: [{ id: '1' }] },
            { name: 'Doing', statuses: [{ id: '3' }, { id: '4' }] },
            { name: 'Done', statuses: [{ id: '5' }] },
            { name: 'Parked', statuses: [] },
          ],
        },
      }
    }
    if (request.path === '/rest/api/3/status') return Object.values(STATUS)
    if (request.path === '/rest/agile/1.0/board/12/issue') {
      return {
        total: 2,
        issues: [
          issuePayload({ status: STATUS.review }),
          // A status that no column of the board lists.
          issuePayload({ id: '10009', key: 'ACME-9', status: { id: '99', name: 'Archived', statusCategory: { key: 'done' } } }),
        ],
      }
    }
    throw new Error(`unexpected request ${request.path}`)
  }

  test('reads the columns from the board configuration, with the category of the first status', async () => {
    // WHY: a board column is a group of statuses that a person named. Solus
    // shows the names of the board, and Jira gives a category only for a status.
    const { jira, requests } = fakeJira(boardAnswers)

    const read = await new JiraBoardSource(jira).read(BOARD_SOURCE)

    expect(read.label).toBe('Launch sprint')
    expect(read.columns).toEqual([
      { id: 'To Do', name: 'To Do', category: 'open' },
      { id: 'Doing', name: 'Doing', category: 'active' },
      { id: 'Done', name: 'Done', category: 'done' },
      { id: 'Parked', name: 'Parked', category: 'open' },
    ])
    expect(read.writeState).toEqual(BOARD_WRITE_STATE)
    expect(read.items.map((item) => [item.task.reference, item.columnId, item.itemId])).toEqual([
      ['ACME-7', 'Doing', null],
      ['ACME-9', null, null],
    ])
    expect(read.truncated).toBe(false)
    const issues = requests.find((request) => request.path.endsWith('/issue'))
    expect(issues?.query).toMatchObject({ maxResults: '50', startAt: '0', jql: 'ORDER BY updated DESC' })
  })

  test('stops at the cap and says that the board holds more', async () => {
    const { jira, requests } = fakeJira((request) => {
      if (!request.path.endsWith('/issue')) return boardAnswers(request)
      const startAt = Number(request.query?.startAt)
      return {
        total: 430,
        issues: Array.from({ length: 50 }, (_, index) => issuePayload({ id: `${startAt + index}`, key: `ACME-${startAt + index}` })),
      }
    })

    const read = await new JiraBoardSource(jira).read(BOARD_SOURCE)

    expect(read.items).toHaveLength(MAX_SOURCE_TASKS)
    expect(read.truncated).toBe(true)
    expect(requests.filter((request) => request.path.endsWith('/issue')).map((request) => request.query?.startAt))
      .toEqual(['0', '50', '100', '150'])
  })

  test('a refusal of the Agile API asks the person to connect again', async () => {
    // WHY: the connection can be good for Jira and not have the Jira Software
    // permission. The fix is to connect again, so the health is `reconnect`.
    const { jira } = fakeJira((request) => {
      if (request.path.startsWith('/rest/agile/')) throw new JiraRequestError(403, 'Forbidden')
      return boardAnswers(request)
    })
    const read = new JiraBoardSource(jira).read(BOARD_SOURCE)
    await expect(read).rejects.toBeInstanceOf(TaskProviderError)
    await expect(read).rejects.toMatchObject({
      health: 'reconnect',
      message: 'Connect Atlassian again to give Solus the Jira Software permission that boards need.',
    })
  })

  test('a board that Jira does not give is a no-access failure', async () => {
    const { jira } = fakeJira((request) => {
      if (request.path.startsWith('/rest/agile/')) throw new JiraRequestError(404, 'Not found')
      return boardAnswers(request)
    })
    await expect(new JiraBoardSource(jira).read(BOARD_SOURCE)).rejects.toMatchObject({ health: 'no_access' })
  })

  test('search asks the board for the text, escaped', async () => {
    const { jira, requests } = fakeJira(boardAnswers)
    await new JiraBoardSource(jira).search(BOARD_SOURCE, 'say "hi"')
    expect(requests[0]?.path).toBe('/rest/agile/1.0/board/12/issue')
    expect(requests[0]?.query?.jql).toBe('(summary ~ "say \\"hi\\"" OR key = "say \\"hi\\"")')
  })

  test('a move is a legal transition to one of the statuses of the column', async () => {
    // WHY: a column can list more than one status, and the workflow decides
    // which of them the issue can reach now.
    const { jira, requests } = fakeJira(issueAnswers({ transitions: [TRANSITIONS[1], TRANSITIONS[2]] }))

    await new JiraBoardSource(jira).move({
      source: BOARD_SOURCE,
      writeState: BOARD_WRITE_STATE,
      home: HOME,
      itemId: null,
      columnId: 'Doing',
    })

    expect(transitionPosts(requests).map((request) => request.body)).toEqual([{ transition: { id: '31' } }])
  })

  test('a move with no legal transition names the column and sends no transition', async () => {
    const { jira, requests } = fakeJira(issueAnswers({ transitions: [TRANSITIONS[0]] }))
    await expect(new JiraBoardSource(jira).move({
      source: BOARD_SOURCE,
      writeState: BOARD_WRITE_STATE,
      home: HOME,
      itemId: null,
      columnId: 'Done',
    })).rejects.toThrow("No Jira transition from ACME-7's current status reaches Done.")
    expect(transitionPosts(requests)).toHaveLength(0)
  })

  test('create needs the project of the board, and moves the new issue to its column', async () => {
    const { jira, requests } = fakeJira((request) => {
      if (request.path.includes('/issuetypes')) return { issueTypes: [{ id: '11', name: 'Task' }] }
      if (request.path === '/rest/api/3/issue' && request.method === 'POST') return { id: '10008', key: 'ACME-8' }
      return issueAnswers({ issue: { id: '10008', key: 'ACME-8' } })(request)
    })
    const source = new JiraBoardSource(jira)

    await expect(source.create({
      source: BOARD_SOURCE,
      writeState: { ...BOARD_WRITE_STATE, projectKey: null },
      draft: { title: 'New work' },
    })).rejects.toThrow('This board has no project. Create the task in Jira.')
    expect(requests).toHaveLength(0)

    await source.create({ source: BOARD_SOURCE, writeState: BOARD_WRITE_STATE, draft: { title: 'New work', columnId: 'Done' } })

    expect(requests.find((request) => request.path === '/rest/api/3/issue')?.body)
      .toMatchObject({ fields: { project: { key: 'ACME' }, summary: 'New work' } })
    expect(transitionPosts(requests).map((request) => request.body)).toEqual([{ transition: { id: '41' } }])
  })
})

describe('publishing a body to Jira', () => {
  // Jira takes a file as an attachment of the issue, not as a URL in the body.
  // These tests pin the one multipart write, and the rule that makes a retry
  // safe: a publication is recorded for each issue.
  const PNG_ID = `${'a'.repeat(64)}.png`
  const HTML_ID = `${'b'.repeat(64)}.html`
  const previousDataDir = process.env.SOLUS_DATA_DIR
  let dataDir = ''
  let attachmentCounter = 0

  function attachmentAnswers(request: JiraRequest): unknown {
    if (!request.path.endsWith('/attachments')) throw new Error(`unexpected request ${request.path}`)
    if (!(request.body instanceof FormData)) throw new Error('attachments must be multipart')
    if (!(request.body.get('file') instanceof Blob)) throw new Error('the attachment file is missing')
    attachmentCounter += 1
    return [{
      id: String(attachmentCounter),
      filename: 'file',
      content: `https://acme.atlassian.net/rest/api/3/attachment/content/${attachmentCounter}`,
    }]
  }

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'solus-jira-assets-'))
    process.env.SOLUS_DATA_DIR = dataDir
    mkdirSync(join(dataDir, 'assets'), { recursive: true })
    writeFileSync(join(dataDir, 'assets', PNG_ID), Buffer.from('fake png bytes'))
    writeFileSync(join(dataDir, 'assets', HTML_ID), Buffer.from('<!doctype html><title>Report</title>'))
  })

  beforeEach(() => {
    attachmentCounter = 0
  })

  afterAll(async () => {
    await resetTestDatabase()
    if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
    else process.env.SOLUS_DATA_DIR = previousDataDir
    rmSync(dataDir, { recursive: true, force: true })
  })

  test('Jira refuses no asset type', () => {
    const { jira } = fakeJira(attachmentAnswers)
    expect(new JiraTaskProvider(jira).unpublishableAssets(HOME, `[report](asset://${HTML_ID}) ![still](asset://${PNG_ID})`))
      .toEqual([])
  })

  test('attaches each asset to the issue and links it from the sent body', async () => {
    const { jira, requests } = fakeJira(attachmentAnswers)
    const body = `![Latency report](asset://${PNG_ID})\n\nSource: [report.html](asset://${HTML_ID})`

    const published = await new JiraTaskProvider(jira).publishAssets({ ...HOME, key: 'ACME-20' }, body)

    expect(requests).toHaveLength(2)
    for (const request of requests) {
      expect(request.method).toBe('POST')
      expect(request.path).toBe('/rest/api/3/issue/ACME-20/attachments')
    }
    // ADF cannot embed an attachment by URL, so the image also becomes a link.
    expect(published).toBe(
      '[Latency report](https://acme.atlassian.net/rest/api/3/attachment/content/1)\n\n'
      + 'Source: [report.html](https://acme.atlassian.net/rest/api/3/attachment/content/2)',
    )
  })

  test('a retry on the same issue attaches nothing a second time, and another issue gets its own file', async () => {
    // WHY: an upload cannot be undone, and the caller sends a failed comment
    // again. Without the record, each retry adds one more attachment. An
    // attachment is a file of one issue, so the record is for each issue.
    const { jira, requests } = fakeJira(attachmentAnswers)
    const provider = new JiraTaskProvider(jira)
    const body = `![still](asset://${PNG_ID})`

    const first = await provider.publishAssets({ ...HOME, key: 'ACME-21' }, body)
    const second = await provider.publishAssets({ ...HOME, key: 'ACME-21' }, body)
    expect(requests).toHaveLength(1)
    expect(second).toBe(first)

    const other = await provider.publishAssets({ ...HOME, key: 'ACME-22' }, body)
    expect(requests).toHaveLength(2)
    expect(other).toContain('/attachment/content/2')
  })

  test('a body with no local reference makes no request', async () => {
    const { jira, requests } = fakeJira(attachmentAnswers)
    const body = 'Plain text, and https://example.com/image.png'
    expect(await new JiraTaskProvider(jira).publishAssets(HOME, body)).toBe(body)
    expect(requests).toHaveLength(0)
  })
})

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { z } from 'zod'
import type { AtlassianRequest } from '@solus/server/atlassian/api'

const jqlBodySchema = z.object({ jql: z.string() })

// Jira's workflow is the thing that makes this adapter more than a field map:
// there is no "set the status" write, only transitions the current status
// allows. These tests pin how that is chosen, and what happens when nothing
// legal reaches the target.

const CLOUD_ID = 'cloud-1'
const SCOPE = { provider: 'jira' as const, externalKey: `${CLOUD_ID}/ACME` }
const REF = { ...SCOPE, externalId: 'ACME-7', url: '' }

let requests: AtlassianRequest[] = []
let transitions: Array<{ id: string; name: string; to: { name: string; statusCategory: { key: string } } }> = []
let issueStatus = { name: 'To Do', statusCategory: { key: 'new' } }

function issuePayload() {
  return {
    key: 'ACME-7',
    fields: {
      summary: 'Ship the thing',
      description: {
        type: 'doc',
        version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Body text' }] }],
      },
      updated: '2026-08-01T10:00:00.000+0000',
      labels: ['infra'],
      status: issueStatus,
      priority: { name: 'Highest' },
      comment: {
        comments: [{
          id: '9001',
          author: { displayName: 'Ada' },
          body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Looks good' }] }] },
          created: '2026-08-01T09:00:00.000+0000',
        }],
      },
    },
  }
}

/** Set by a test that needs the search endpoint to answer something other than
 *  the one stock issue — paging, or a change set bigger than the cap. */
let searchResponse: ((request: AtlassianRequest) => unknown) | null = null

function payloadFor(request: AtlassianRequest): unknown {
  if (request.path.endsWith('/transitions')) {
    return request.method === 'POST' ? undefined : { transitions }
  }
  if (request.path === '/rest/api/3/search/jql') {
    return searchResponse ? searchResponse(request) : { issues: [issuePayload()] }
  }
  if (request.path.includes('/issuetypes')) {
    return { issueTypes: [{ id: '10', name: 'Sub-task', subtask: true }, { id: '11', name: 'Task' }] }
  }
  if (request.path === '/rest/api/3/issue' && request.method === 'POST') return { key: 'ACME-8' }
  if (request.method === 'PUT') return undefined
  if (request.path.endsWith('/comment')) {
    return {
      id: '9002',
      author: { displayName: 'Ada' },
      body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'posted' }] }] },
      created: '2026-08-01T11:00:00.000+0000',
    }
  }
  return issuePayload()
}

mock.module('@solus/server/atlassian/api', () => ({
  IGNORED_RESPONSE: z.unknown(),
  atlassianRequest: <Schema extends z.ZodType>(
    request: AtlassianRequest,
    schema: Schema,
  ): Promise<z.infer<Schema>> => {
    requests.push(request)
    return Promise.resolve(schema.parse(payloadFor(request)))
  },
  connectedSiteUrl: () => Promise.resolve('https://acme.atlassian.net'),
  connectedSite: () => Promise.resolve({ cloudId: CLOUD_ID, siteUrl: 'https://acme.atlassian.net' }),
}))

const { JiraTaskSyncAdapter } = await import('@solus/server/tasks/adapters/jira')

let adapter: InstanceType<typeof JiraTaskSyncAdapter>

beforeEach(() => {
  requests = []
  searchResponse = null
  issueStatus = { name: 'To Do', statusCategory: { key: 'new' } }
  transitions = [
    { id: '2', name: 'Start', to: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } },
    { id: '3', name: 'Review', to: { name: 'In Review', statusCategory: { key: 'indeterminate' } } },
    { id: '4', name: 'Finish', to: { name: 'Done', statusCategory: { key: 'done' } } },
  ]
  adapter = new JiraTaskSyncAdapter()
})

describe('status fidelity', () => {
  test('separates in-review from in-progress, and merges done with dropped', () => {
    // WHY: the sync engine derives both directions from this one answer. Jira
    // workflows do model review; the Done category cannot tell a finished issue
    // from an abandoned one, so a local `dropped` must survive an upstream Done.
    expect(adapter.statusKey('in_review')).not.toBe(adapter.statusKey('in_progress'))
    expect(adapter.statusKey('dropped')).toBe(adapter.statusKey('done'))
    expect(adapter.statusKey('inbox')).toBe(adapter.statusKey('todo'))
  })

  test('reads a review-named status inside the in-progress category as in_review', async () => {
    issueStatus = { name: 'In Review', statusCategory: { key: 'indeterminate' } }
    expect((await adapter.fetchTicket(REF)).status).toBe('in_review')
  })

  test('reads an ordinary in-progress status as in_progress', async () => {
    issueStatus = { name: 'Building', statusCategory: { key: 'indeterminate' } }
    expect((await adapter.fetchTicket(REF)).status).toBe('in_progress')
  })
})

describe('pushing a status', () => {
  test('transitions to a destination in the target category', async () => {
    await adapter.pushFields(REF, { status: 'done' })
    const posted = requests.find((request) => request.method === 'POST' && request.path.endsWith('/transitions'))
    expect(posted?.body).toEqual({ transition: { id: '4' } })
  })

  test('prefers a review-named destination when the target is in_review', async () => {
    // WHY: both "In Progress" and "In Review" sit in the same Jira category, so
    // the category alone would land review work in the wrong column.
    await adapter.pushFields(REF, { status: 'in_review' })
    const posted = requests.find((request) => request.method === 'POST' && request.path.endsWith('/transitions'))
    expect(posted?.body).toEqual({ transition: { id: '3' } })
  })

  test('fails by name when no legal transition reaches the target', async () => {
    // WHY: guessing a nearby state would put the issue somewhere nobody asked
    // for, and the board would then report a status Jira does not hold.
    transitions = [{ id: '2', name: 'Start', to: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } }]
    expect(adapter.pushFields(REF, { status: 'done' })).rejects.toThrow(/no jira transition.*done/i)
  })

  test('writes fields and priority in one issue update', async () => {
    await adapter.pushFields(REF, { title: 'New title', priority: 'urgent', labels: ['a'] })
    const update = requests.find((request) => request.method === 'PUT')
    expect(update?.body).toEqual({
      fields: { summary: 'New title', labels: ['a'], priority: { name: 'Highest' } },
    })
  })

  test('clears a priority the task no longer has', async () => {
    // WHY: an unset local priority must reach Jira as "none", not as "leave it".
    await adapter.pushFields(REF, { priority: null })
    expect(requests.find((request) => request.method === 'PUT')?.body)
      .toEqual({ fields: { priority: null } })
  })
})

describe('addressing', () => {
  test('links to the site hostname, not the API gateway', async () => {
    // WHY: `api.atlassian.com` needs a bearer token, so a link built from it is
    // dead in a browser. The external key carries a cloudId precisely so the
    // hostname comes from the live connection.
    expect(await adapter.ticketUrl(SCOPE, 'ACME-7')).toBe('https://acme.atlassian.net/browse/ACME-7')
  })

  test('refuses an external key that is not <cloudId>/<projectKey>', () => {
    expect(() => adapter.ticketUrl({ provider: 'jira', externalKey: 'ACME' }, 'ACME-7'))
      .toThrow(/invalid jira task scope/i)
  })

  test('normalizes the issue body, comments, and priority', async () => {
    const ticket = await adapter.fetchTicket(REF)
    expect(ticket.body).toBe('Body text')
    expect(ticket.priorityHint).toBe('urgent')
    expect(ticket.comments).toEqual([
      { externalId: '9001', author: 'Ada', body: 'Looks good', createdAt: Date.parse('2026-08-01T09:00:00.000+0000') },
    ])
  })
})

describe('finding issues to import', () => {
  test('lists provider-owned Jira tickets in the bound project', async () => {
    // WHY: binding Jira must show live Jira rows on the same Tasks page as a
    // GitHub binding; importing is not required merely to browse or update one.
    const result = await adapter.listTickets(SCOPE)
    expect(result.tasks).toEqual([
      expect.objectContaining({
        id: 'ACME-7',
        providerId: 'jira',
        title: 'Ship the thing',
        status: 'todo',
        priority: 'urgent',
      }),
    ])
    const search = requests.find((request) => request.path === '/rest/api/3/search/jql')
    expect(jqlBodySchema.parse(search?.body).jql).toBe('project = "ACME" ORDER BY updated DESC')
  })

  test('scopes the search to the bound project and escapes the query', async () => {
    // WHY: an unescaped quote turns a search box into a JQL injection, and an
    // unscoped search offers issues from projects this binding cannot sync.
    await adapter.listCandidates(SCOPE, { query: 'say "hi"' })
    const search = requests.find((request) => request.path === '/rest/api/3/search/jql')
    const { jql } = jqlBodySchema.parse(search?.body)
    expect(jql).toContain('project = "ACME"')
    expect(jql).toContain('say \\"hi\\"')
  })

  test('pushes inbox involvement into JQL before applying the result cap', async () => {
    // WHY: filtering a capped response on the client silently drops the older
    // assigned work the inbox is meant to surface.
    await adapter.listTickets(SCOPE, { involvement: 'assigned' })
    const search = requests.find((request) => request.path === '/rest/api/3/search/jql')
    expect(jqlBodySchema.parse(search?.body).jql)
      .toBe('project = "ACME" AND assignee = currentUser() ORDER BY updated DESC')
  })

  test('rejects involvement Jira cannot express instead of approximating it', () => {
    expect(adapter.listTickets(SCOPE, { involvement: 'mentioned' }))
      .rejects.toThrow(/cannot express mentioned involvement/i)
  })

  test('creates with the project default issue type, never a sub-task', async () => {
    // WHY: a sub-task cannot exist without a parent, so publishing a task under
    // one fails on Jira's side with an error nobody can act on.
    await adapter.createTicket(SCOPE, { title: 'New work' })
    const created = requests.find((request) => request.path === '/rest/api/3/issue')
    expect(created?.body).toMatchObject({ fields: { issuetype: { id: '11' }, project: { key: 'ACME' } } })
  })
})

describe('polling a scope instead of every ticket', () => {
  // WHY: the sync poll used to cost one GET per linked issue, every five
  // minutes, whether or not anything had happened. One project with a few
  // hundred linked tasks is then a few hundred requests an interval, forever.
  test('asks one query for the whole scope, over a window that reaches back to `since`', async () => {
    // Six and a half minutes, not seven: the adapter rounds the gap up, so an
    // exact multiple of a minute lands on the rounding boundary and the window
    // is 9m or 10m depending on whether both `Date.now()` calls read the same
    // millisecond. Half a minute inside the bucket asserts the same rounding
    // without racing the clock.
    const since = Date.now() - 6.5 * 60_000
    searchResponse = () => ({ issues: [{ key: 'ACME-7' }, { key: 'ACME-9' }], isLast: true })

    const changed = await adapter.changedSince(SCOPE, since)

    expect(changed).toEqual(new Set(['ACME-7', 'ACME-9']))
    const searches = requests.filter((request) => request.path === '/rest/api/3/search/jql')
    expect(searches).toHaveLength(1)
    // Nine minutes: six and a half since the last sync rounds up to seven, plus
    // the overlap that covers JQL's minute granularity and any clock difference
    // with Atlassian.
    expect(jqlBodySchema.parse(searches[0]?.body).jql)
      .toBe('project = "ACME" AND updated >= -9m ORDER BY updated DESC')
  })

  // A delta query that carried issue bodies and comment threads would cost more
  // than the per-ticket poll it replaces.
  test('reads keys only', async () => {
    searchResponse = () => ({ issues: [], isLast: true })
    await adapter.changedSince(SCOPE, Date.now() - 60_000)
    expect(requests[0]?.body).toMatchObject({ fields: ['updated'] })
  })

  // Past a certain churn, listing what changed is no cheaper than asking about
  // each link. Saying "cannot answer" puts the caller back on the path that
  // always works.
  test('gives up rather than paging through an unbounded change set', async () => {
    let page = 0
    searchResponse = () => {
      page++
      return {
        issues: Array.from({ length: 100 }, (_, index) => ({ key: `ACME-${page * 100 + index}` })),
        nextPageToken: `page-${page}`,
      }
    }

    await expect(adapter.changedSince(SCOPE, Date.now() - 60_000)).resolves.toBeNull()
    expect(page).toBeLessThanOrEqual(7)
  })
})

describe('what a browse row costs', () => {
  // WHY: the list used to attach the whole issue — description, every comment —
  // to every row as `raw`, cache it as one JSON blob, and send it to every
  // client on each refresh. Nothing read it.
  test('carries no provider payload on a list row', async () => {
    const { tasks } = await adapter.listTickets(SCOPE)
    expect(tasks[0]).toMatchObject({ id: 'ACME-7', title: 'Ship the thing' })
    expect(tasks[0]?.raw).toBeUndefined()
  })

  test('does not ask Jira for comments it will not show', async () => {
    await adapter.listTickets(SCOPE)
    const search = requests.find((request) => request.path === '/rest/api/3/search/jql')
    expect(search?.body).toMatchObject({ fields: expect.not.arrayContaining(['comment']) })
  })

  // The detail view is the one place a comment thread is read, and it fetches
  // its own issue.
  test('still reads comments when fetching one ticket', async () => {
    const ticket = await adapter.fetchTicket(REF)
    expect(ticket.comments).toHaveLength(1)
  })
})

describe('searching past the list cap', () => {
  // WHY: the list stops at the 200 most recently updated issues. Filtering that
  // page answers "not found" for anything older, while looking like it searched
  // the project.
  test('sends the text to Jira rather than filtering the loaded page', async () => {
    await adapter.listTickets(SCOPE, { query: 'payment retry' })
    const search = requests.find((request) => request.path === '/rest/api/3/search/jql')
    const { jql } = jqlBodySchema.parse(search?.body)
    expect(jql).toContain('summary ~ "payment retry"')
    expect(jql).toContain('key = "payment retry"')
  })

  test('escapes a list query so it cannot be read as JQL', async () => {
    await adapter.listTickets(SCOPE, { query: 'say "hi"' })
    const search = requests.find((request) => request.path === '/rest/api/3/search/jql')
    expect(jqlBodySchema.parse(search?.body).jql).toContain('say \\"hi\\"')
  })
})

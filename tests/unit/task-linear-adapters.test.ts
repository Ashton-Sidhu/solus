import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { LinearVariables } from '@solus/server/data/tasks/providers/linear-api'
import type { ProviderTask, TaskHome } from '@solus/server/data/tasks/providers/types'
import { actAsHostForTests } from '@solus/server/execution/seats/acting-identity'

// WHY: the Linear issue page read the issue and then inspected it, and each
// write read the team's choices and the whole issue before its mutation. One
// query now gives the page, and a write is its mutation, with the team's
// choices kept from a recent read.

const linearApi = await import('@solus/server/data/tasks/providers/linear-api')
interface LinearCall { query: string; variables: LinearVariables }
const calls: LinearCall[] = []
let answer: (call: LinearCall) => unknown = () => ({})
mock.module('@solus/server/data/tasks/providers/linear-api', () => ({
  ...linearApi,
  linearRequest: async (query: string, variables: LinearVariables, schema: { parse: (value: unknown) => unknown }) => {
    const call = { query, variables }
    calls.push(call)
    return schema.parse(answer(call))
  },
}))
const { LinearTaskProvider, LinearTeamSource } = await import('@solus/server/data/tasks/providers/linear')

// The adapter keeps choices for each person; with no caller, it acts as the host.
actAsHostForTests()

const WORKSPACE = 'org-1'
const TEAM = 'team-1'
type LinearHome = Extract<TaskHome, { provider: 'linear' }>
const HOME: LinearHome = { provider: 'linear', workspaceId: WORKSPACE, issueId: 'issue-1', teamId: TEAM }
const STATE = { id: 'state-todo', name: 'Todo', type: 'unstarted' }
const DONE = { id: 'state-done', name: 'Done', type: 'completed' }
const ISSUE = {
  id: 'issue-1', identifier: 'ENG-1', title: 'Fix login', description: 'Body', url: 'https://linear.app/acme/issue/ENG-1',
  createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-02T00:00:00.000Z', priority: 2, dueDate: null,
  state: STATE, team: { id: TEAM, key: 'ENG' }, assignee: null, creator: { id: 'u1', name: 'Ada', email: 'ada@acme.dev' },
  labels: { nodes: [] },
}
const CURRENT: ProviderTask = {
  ref: { provider: 'linear', workspaceId: WORKSPACE, id: 'issue-1' }, kind: 'issue', reference: 'ENG-1', url: ISSUE.url,
  title: 'Fix login', body: 'Body', state: { name: 'Todo', category: 'open' }, stateId: STATE.id, labels: [],
  writableFields: ['title', 'body', 'labels', 'assignee', 'priority', 'dueDate'], home: HOME, updatedAt: 0,
}
let teamNumber = 0
/** A new team for each test, so no test sees the choices another kept. */
function freshTeam(): LinearHome {
  return { ...HOME, teamId: `${TEAM}-${++teamNumber}` }
}
function choicesAnswer(teamId: string) {
  return {
    organization: { id: WORKSPACE },
    team: {
      id: teamId, name: 'Engineering',
      states: { nodes: [STATE, DONE] },
      members: { nodes: [{ id: 'u1', name: 'Ada', email: 'ada@acme.dev', avatarUrl: null }] },
      labels: { nodes: [{ id: 'l1', name: 'bug' }] },
    },
  }
}
function linear(call: LinearCall): unknown {
  if (call.query.includes('states {')) return choicesAnswer(call.variables.id ?? TEAM)
  if (call.query.includes('issueUpdate')) return { issueUpdate: { success: true, issue: { ...ISSUE, state: DONE } } }
  return {
    organization: { id: WORKSPACE },
    viewer: { id: 'u1' },
    issue: {
      ...ISSUE,
      comments: { nodes: [{ id: 'c1', body: 'Hi', createdAt: '2026-08-01T01:00:00.000Z', user: { name: 'Ada' }, reactions: [] }], pageInfo: { hasNextPage: false, endCursor: null } },
      reactions: [],
      history: { nodes: [{ id: 'h1', createdAt: '2026-08-01T02:00:00.000Z', actor: { name: 'Ada' }, fromState: null, toState: { name: 'Todo' }, fromTitle: null, toTitle: null, addedLabels: null, removedLabels: null }], pageInfo: { hasPreviousPage: false, startCursor: null } },
      attachments: { nodes: [] },
    },
  }
}

beforeEach(() => {
  calls.length = 0
  answer = linear
})

describe('the calls of a Linear issue', () => {
  test('the detail read is one query with the history, reactions and links', async () => {
    const details = await new LinearTaskProvider().fetch({ provider: 'linear', workspaceId: WORKSPACE, id: 'issue-1' })
    expect(calls).toHaveLength(1)
    expect(details.comments.map((comment) => comment.id)).toEqual(['c1'])
    expect(details.providerMetadata?.events?.map((event) => event.id)).toEqual(['h1'])
    expect(details.providerMetadata?.capabilities).toMatchObject({ history: true, reactions: true })
  })

  test('a move is one mutation once the team choices are kept', async () => {
    const home = freshTeam()
    const provider = new LinearTaskProvider()
    await provider.setState(home, 'done', { ...CURRENT, home })
    expect(calls.map((call) => call.query.includes('states {') ? 'choices' : 'mutation')).toEqual(['choices', 'mutation'])

    calls.length = 0
    const moved = await provider.setState(home, 'done', { ...CURRENT, home })
    expect(calls.map((call) => call.query.includes('issueUpdate'))).toEqual([true])
    expect(moved.state).toEqual({ name: 'Done', category: 'done' })
  })

  test('a title update reads nothing before its mutation', async () => {
    await new LinearTaskProvider().update(freshTeam(), { title: 'New title' }, CURRENT)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.query).toContain('issueUpdate')
  })

  test('a label the kept choices lack reads the team once more', async () => {
    // WHY: a label made in Linear after the copy was kept must not be refused.
    const home = freshTeam()
    const provider = new LinearTaskProvider()
    await provider.update(home, { labels: ['bug'] }, CURRENT)
    calls.length = 0
    answer = (call) => {
      if (!call.query.includes('states {')) return linear(call)
      const fresh = choicesAnswer(home.teamId)
      fresh.team.labels.nodes.push({ id: 'l2', name: 'urgent' })
      return fresh
    }
    await provider.update(home, { labels: ['urgent'] }, CURRENT)
    expect(calls.map((call) => call.query.includes('states {') ? 'choices' : 'mutation')).toEqual(['choices', 'mutation'])
    expect(calls[1]?.variables.input?.labelIds).toEqual(['l2'])
  })

  test('a source read always reads the team, so its columns are fresh', async () => {
    const source = { kind: 'linear-team' as const, workspaceId: WORKSPACE, teamId: freshTeam().teamId, teamKey: 'ENG' }
    answer = (call) => call.query.includes('issues(first') ? { team: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } : linear(call)
    await new LinearTeamSource().read(source)
    await new LinearTeamSource().read(source)
    expect(calls.filter((call) => call.query.includes('states {'))).toHaveLength(2)
  })
})

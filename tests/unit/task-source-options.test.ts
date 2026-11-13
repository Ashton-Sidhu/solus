import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import type { TaskSourceOptionsDeps } from '@solus/server/data/tasks/source-options'
import { JiraRequestError } from '@solus/server/data/tasks/providers/types'

// The module's default connections reach the vault, which loads the database module.
mock.module('node:sqlite', () => ({ DatabaseSync }))

let taskSourceOptions: typeof import('@solus/server/data/tasks/source-options').taskSourceOptions
beforeAll(async () => {
  ;({ taskSourceOptions } = await import('@solus/server/data/tasks/source-options'))
})

// WHY: the source setup tells a person what they can add and what to fix
// first. An empty list must mean "there is none", never "Solus could not ask":
// a missing connection or permission has its own answer.

const VIEWER_PROJECTS = {
  viewer: {
    login: 'octocat',
    projectsV2: { nodes: [{ number: 7, title: 'Roadmap', closed: false }, { number: 8, title: 'Old plan', closed: true }, null] },
    organizations: { nodes: [{ login: 'acme', projectsV2: { nodes: [{ number: 2, title: 'Platform' }] } }, null] },
  },
}

const VIEWER_REPOSITORIES = {
  viewer: { repositories: { nodes: [{ owner: { login: 'acme' }, name: 'app' }, null, { owner: { login: 'octocat' }, name: 'dotfiles' }] } },
}

/** Connections that all work. A test replaces the part it is about. */
function deps(overrides: Partial<TaskSourceOptionsDeps> = {}): TaskSourceOptionsDeps {
  return {
    githubStatus: async () => ({ connected: true, login: 'octocat', scopes: ['repo', 'project'] }),
    hasGithubCredential: async () => true,
    // SAFETY: the options read calls only `graphql` of the client.
    github: (_operation, run) => run({ graphql: async (query: string) => query.includes('repositories(') ? VIEWER_REPOSITORIES : VIEWER_PROJECTS } as never),
    jiraSite: async () => ({ cloudId: 'site', siteUrl: 'https://acme.atlassian.net' }),
    jira: {
      // SAFETY: each path answers the payload its schema reads.
      request: async (request, schema) => schema.parse(request.path.startsWith('/rest/agile/')
        ? { values: [{ id: 12, name: 'SOL board', location: { projectKey: 'SOL' } }, { id: 13, name: 'Personal board' }] }
        : { values: [{ key: 'SOL', name: 'Solus' }] }),
      siteUrl: async () => 'https://acme.atlassian.net',
    },
    ...overrides,
  }
}

describe('what a person can choose as a task source', () => {
  test('with both connections: the recent repositories, the open Projects of the person and their organizations, the Jira projects and boards', async () => {
    // No project is named: a task source belongs to the person, not to a project.
    const options = await taskSourceOptions(deps())
    expect(options.github).toEqual({
      connected: true,
      login: 'octocat',
      hasProjectScope: true,
      // The repositories the person pushed to most recently, in GitHub's order.
      repositories: [{ owner: 'acme', repo: 'app' }, { owner: 'octocat', repo: 'dotfiles' }],
      // A closed Project is not offered; an organization's Projects follow the person's own.
      projects: [{ owner: 'octocat', number: 7, title: 'Roadmap' }, { owner: 'acme', number: 2, title: 'Platform' }],
    })
    expect(options.jira).toEqual({
      connected: true,
      cloudId: 'site',
      siteUrl: 'https://acme.atlassian.net',
      projects: [{ projectKey: 'SOL', name: 'Solus' }],
      boards: [{ boardId: 12, name: 'SOL board', projectKey: 'SOL' }, { boardId: 13, name: 'Personal board' }],
    })
  })

  test('not connected: each provider says so and asks nothing', async () => {
    const calls: string[] = []
    const options = await taskSourceOptions(deps({
      githubStatus: async () => ({ connected: false }),
      hasGithubCredential: async () => false,
      github: async () => { calls.push('github'); throw new Error('GitHub is not connected') },
      jiraSite: async () => null,
      jira: { request: async () => { calls.push('jira'); throw new Error('not reached') }, siteUrl: async () => null },
    }))
    expect(options.github).toEqual({ connected: false, repositories: [], projects: [] })
    expect(options.jira).toEqual({ connected: false, projects: [], boards: [] })
    expect(calls).toEqual([])
  })

  test('a GitHub connection made before Projects existed says to connect again, and Projects are not asked for', async () => {
    const calls: string[] = []
    const options = await taskSourceOptions(deps({
      githubStatus: async () => ({ connected: true, login: 'octocat', scopes: ['repo'] }),
      github: (operation, run) => {
        calls.push(operation)
        return run({ graphql: async () => VIEWER_REPOSITORIES } as never)
      },
    }))
    // The repositories still list: they need no `project` scope.
    expect(options.github).toMatchObject({ connected: true, hasProjectScope: false, repositories: [{ owner: 'acme', repo: 'app' }, { owner: 'octocat', repo: 'dotfiles' }], projects: [] })
    expect(calls).toEqual(['list_github_task_repositories'])
  })

  test('a credential with no scope list that GitHub refuses for Projects also says to connect again', async () => {
    // `gh` signs in with scopes Solus cannot read: GitHub's own refusal is the answer.
    const options = await taskSourceOptions(deps({
      githubStatus: async () => ({ connected: false }),
      github: async () => { throw Object.assign(new Error('Your token has not been granted the required scopes'), { errors: [{ type: 'INSUFFICIENT_SCOPES' }] }) },
    }))
    expect(options.github).toMatchObject({ connected: true, hasProjectScope: false, projects: [] })
  })

  test('boards that Jira refuses give a reason, and the projects still list', async () => {
    const options = await taskSourceOptions(deps({
      jira: {
        request: async (request, schema) => {
          if (request.path.startsWith('/rest/agile/')) throw new JiraRequestError(403, 'Forbidden')
          return schema.parse({ values: [{ key: 'SOL', name: 'Solus' }] })
        },
        siteUrl: async () => 'https://acme.atlassian.net',
      },
    }))
    expect(options.jira.projects).toEqual([{ projectKey: 'SOL', name: 'Solus' }])
    expect(options.jira.boards).toEqual([])
    expect(options.jira.boardsError).toBe('Connect Atlassian again to give Solus the Jira Software permission that boards need.')
  })
})

import { z } from 'zod'
import type { TaskSourceOptions } from '@solus/contracts/task-types'
import type { AuthStatus } from '@solus/contracts/types'
import { connectedSite } from '../../atlassian/api'
import { createLogger } from '../../logger'
import { githubCredentials } from '../../providers/github/credentials'
import { classifyProviderFailure } from './providers/failures'
import { githubRun, jiraTransport } from './providers/registry'
import type { GithubRun, JiraTransport } from './providers/types'

/**
 * What a person can choose as a task source
 * (docs/plans/provider-owned-tasks.md §7): their GitHub and Jira connections,
 * the repositories they pushed to most recently, and the boards those
 * connections reach. A task source belongs to no project, so nothing here
 * reads a project. Each list is read live and is bounded; nothing here is kept.
 */

const log = createLogger('main', 'task-source-options')

/** The most repositories, Projects, Jira projects or boards one answer lists. */
const MAX_OPTIONS = 50

const VIEWER_REPOSITORIES_QUERY = `
  query {
    viewer {
      repositories(first: ${MAX_OPTIONS}, orderBy: { field: PUSHED_AT, direction: DESC }, affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]) {
        nodes { owner { login } name }
      }
    }
  }
`

const VIEWER_PROJECTS_QUERY = `
  query {
    viewer {
      login
      projectsV2(first: ${MAX_OPTIONS}) { nodes { number title closed } }
      organizations(first: 20) {
        nodes { login projectsV2(first: 20) { nodes { number title closed } } }
      }
    }
  }
`

const projectNodesSchema = z.object({
  nodes: z.array(z.object({ number: z.number(), title: z.string(), closed: z.boolean().nullish() }).nullable()),
})
const viewerRepositoriesSchema = z.object({
  viewer: z.object({
    repositories: z.object({
      nodes: z.array(z.object({ owner: z.object({ login: z.string() }), name: z.string() }).nullable()),
    }),
  }),
})
const viewerProjectsSchema = z.object({
  viewer: z.object({
    login: z.string(),
    projectsV2: projectNodesSchema,
    organizations: z.object({
      nodes: z.array(z.object({ login: z.string(), projectsV2: projectNodesSchema }).nullable()),
    }),
  }),
})
const jiraProjectPageSchema = z.object({ values: z.array(z.object({ key: z.string(), name: z.string() })) })
const jiraBoardPageSchema = z.object({
  values: z.array(z.object({
    id: z.number(),
    name: z.string(),
    location: z.object({ projectKey: z.string().nullish() }).nullish(),
  })),
})

/** The connections the options are read from. A test gives its own. */
export interface TaskSourceOptionsDeps {
  /** The acting person's stored GitHub login, with the scopes GitHub granted. */
  githubStatus(): Promise<AuthStatus>
  /** Whether any GitHub credential can act for the person: `gh` counts, and has no stored login. */
  hasGithubCredential(): Promise<boolean>
  github: GithubRun
  /** The connected Jira site, or null. */
  jiraSite(): Promise<{ cloudId: string; siteUrl: string } | null>
  jira: JiraTransport
}

const defaultDeps: TaskSourceOptionsDeps = {
  githubStatus: () => githubCredentials().status(),
  hasGithubCredential: () => githubCredentials().hasCredential('github.com'),
  github: githubRun,
  jiraSite: () => connectedSite('jira'),
  jira: jiraTransport,
}

type GithubOptions = TaskSourceOptions['github']
type JiraOptions = TaskSourceOptions['jira']

/** The repositories the person pushed to most recently, the newest first. */
async function githubRepositories(github: GithubRun): Promise<GithubOptions['repositories']> {
  const answer = viewerRepositoriesSchema.parse(await github('list_github_task_repositories', ({ graphql }) => graphql(VIEWER_REPOSITORIES_QUERY)))
  return answer.viewer.repositories.nodes
    .flatMap((repository) => repository ? [{ owner: repository.owner.login, repo: repository.name }] : [])
    .slice(0, MAX_OPTIONS)
}

/** The open Projects that the person and their organizations own, the person's own first. */
async function githubProjects(github: GithubRun): Promise<GithubOptions['projects']> {
  const answer = viewerProjectsSchema.parse(await github('list_github_task_projects', ({ graphql }) => graphql(VIEWER_PROJECTS_QUERY)))
  const owners = [
    { login: answer.viewer.login, projectsV2: answer.viewer.projectsV2 },
    ...answer.viewer.organizations.nodes.flatMap((organization) => organization ? [organization] : []),
  ]
  const projects: GithubOptions['projects'] = []
  for (const owner of owners) {
    for (const project of owner.projectsV2.nodes) {
      if (!project || project.closed) continue
      projects.push({ owner: owner.login, number: project.number, title: project.title })
    }
  }
  return projects.slice(0, MAX_OPTIONS)
}

async function githubOptions(deps: TaskSourceOptionsDeps): Promise<GithubOptions> {
  const status = await deps.githubStatus()
  // `gh` can be the person's only GitHub credential: it has no stored login, and it still reads tasks.
  const connected = status.connected || await deps.hasGithubCredential()
  const options: GithubOptions = { connected, repositories: [], projects: [] }
  if (status.login) options.login = status.login
  if (status.scopes) options.hasProjectScope = status.scopes.includes('project') || status.scopes.includes('read:project')
  if (!connected) return options
  await Promise.all([
    githubRepositories(deps.github).then((repositories) => { options.repositories = repositories }, (error: unknown) => {
      const failure = classifyProviderFailure(error)
      log.warn('task_source_github_repositories_unreadable', { health: failure.health, error: failure.message })
    }),
    // A connection that says it has no `project` scope cannot list Projects: do not ask.
    options.hasProjectScope === false ? null : githubProjects(deps.github).then((projects) => { options.projects = projects }, (error: unknown) => {
      const failure = classifyProviderFailure(error)
      // A token with no `project` scope cannot list Projects: the person connects again.
      if (failure.health === 'reconnect') options.hasProjectScope = false
      log.warn('task_source_github_projects_unreadable', { health: failure.health, error: failure.message })
    }),
  ])
  return options
}

async function jiraOptions(deps: TaskSourceOptionsDeps): Promise<JiraOptions> {
  const site = await deps.jiraSite()
  if (!site) return { connected: false, projects: [], boards: [] }
  const options: JiraOptions = { connected: true, cloudId: site.cloudId, siteUrl: site.siteUrl, projects: [], boards: [] }
  try {
    const page = await deps.jira.request(
      { cloudId: site.cloudId, path: '/rest/api/3/project/search', query: { maxResults: String(MAX_OPTIONS), orderBy: 'name' } },
      jiraProjectPageSchema,
    )
    options.projects = page.values.map((project) => ({ projectKey: project.key, name: project.name }))
  } catch (error) {
    log.warn('task_source_jira_projects_unreadable', { error: error instanceof Error ? error.message : String(error) })
  }
  try {
    const page = await deps.jira.request(
      { cloudId: site.cloudId, path: '/rest/agile/1.0/board', query: { maxResults: String(MAX_OPTIONS) } },
      jiraBoardPageSchema,
    )
    options.boards = page.values.map((board) => {
      const projectKey = board.location?.projectKey
      return projectKey ? { boardId: board.id, name: board.name, projectKey } : { boardId: board.id, name: board.name }
    })
  } catch (error) {
    const failure = classifyProviderFailure(error)
    // The Agile API needs the Jira Software permission, which an older connection does not have.
    options.boardsError = failure.health === 'reconnect' || failure.health === 'no_access'
      ? 'Connect Atlassian again to give Solus the Jira Software permission that boards need.'
      : failure.message
    log.warn('task_source_jira_boards_unreadable', { health: failure.health, error: failure.message })
  }
  return options
}

/** What the caller can choose as a task source. */
export async function taskSourceOptions(deps: TaskSourceOptionsDeps = defaultDeps): Promise<TaskSourceOptions> {
  const [github, jira] = await Promise.all([githubOptions(deps), jiraOptions(deps)])
  return { github, jira }
}

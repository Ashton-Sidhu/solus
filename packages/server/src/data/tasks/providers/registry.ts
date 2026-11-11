import type { TaskRef, TaskSource } from '@solus/contracts/task-sources'
import { atlassianRequest, connectedSite, connectedSiteUrl } from '../../../atlassian/api'
import { githubCredentials } from '../../../providers/github/credentials'
import { runGithubRequest } from '../../../providers/github/request'
import { GitHubProjectSource } from '../sources/github-project'
import { GitHubRepoSource } from '../sources/github-repo'
import { JiraBoardSource } from '../sources/jira-board'
import { JiraProjectSource } from '../sources/jira-project'
import { GitHubTaskProvider } from './github'
import { JiraTaskProvider } from './jira'
import {
  JiraRequestError,
  TaskProviderError,
  type GithubRun,
  type JiraTransport,
  type TaskProviderAdapter,
  type TaskSourceAdapter,
} from './types'

/** Tasks are read from `github.com` only (docs/plans/provider-owned-tasks.md §4.1). */
const GITHUB_HOST = 'github.com'

/** GitHub with the acting person's credentials, in the one credential order. */
export const githubRun: GithubRun = async (operation, run) =>
  runGithubRequest(operation, GITHUB_HOST, await githubCredentials().clients(GITHUB_HOST), run)

/** Jira with the acting person's Atlassian connection. */
export const jiraTransport: JiraTransport = {
  async request(request, schema) {
    // "No connection" must not read as a refused call: the fix is to connect, not to reconnect.
    if (!(await connectedSite('jira'))) throw new TaskProviderError('not_connected', 'Connect Atlassian to read Jira tasks.')
    return atlassianRequest(
      { ...request, product: 'jira', failure: (failure) => new JiraRequestError(failure.status, failure.detail) },
      schema,
    )
  },
  siteUrl: connectedSiteUrl,
}

/** The provider adapters of tasks: one for each source kind, one for each provider. */
export interface TaskAdapters {
  source(kind: TaskSource['kind']): TaskSourceAdapter
  provider(id: TaskRef['provider']): TaskProviderAdapter
}

function createTaskAdapters(github: GithubRun, jira: JiraTransport): TaskAdapters {
  const sources: TaskSourceAdapter[] = [
    new GitHubRepoSource(github),
    new GitHubProjectSource(github),
    new JiraProjectSource(jira),
    new JiraBoardSource(jira),
  ]
  const providers: TaskProviderAdapter[] = [new GitHubTaskProvider(github), new JiraTaskProvider(jira)]
  return {
    source(kind) {
      const adapter = sources.find((candidate) => candidate.kind === kind)
      if (!adapter) throw new Error(`Task source kind "${kind}" is not supported.`)
      return adapter
    },
    provider(id) {
      const adapter = providers.find((candidate) => candidate.id === id)
      if (!adapter) throw new Error(`Task provider "${id}" is not supported.`)
      return adapter
    },
  }
}

let adapters: TaskAdapters | null = null

/** The adapters every task read and write goes through. */
export function taskAdapters(): TaskAdapters {
  adapters ??= createTaskAdapters(githubRun, jiraTransport)
  return adapters
}

/** Tests only: put fake adapters in place of GitHub and Jira, or null for the real ones. */
export function useTaskAdaptersForTests(next: TaskAdapters | null): void {
  adapters = next
}

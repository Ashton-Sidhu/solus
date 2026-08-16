import { rm } from 'fs/promises'
import { z } from 'zod'
import type {
  GithubPublishPushStep,
  GithubPublishRemoteStep,
  GithubPublishRepositoryRequest,
  GithubPublishRepositoryResult,
  GithubPublishRepositoryStep,
} from '../../shared/types'
import type { GitHubClient } from '../providers/github/octokit'
import { githubApiErrorMessage } from '../providers/github/provider'
import { applyCloneProtocol } from '../server/handlers/setup-commands'
import { runAsync } from './exec'
import { createGitAskpassHelper, gitAuthEnv } from './git-auth-env'
import { parseRemoteUrl } from './git-helpers'
import { hasAnyCommit } from './git-init'

const githubStatusErrorSchema = z.object({ status: z.number().optional() })

function isNotFoundError<T>(err: T): boolean {
  const parsed = githubStatusErrorSchema.safeParse(err)
  return parsed.success && parsed.data.status === 404
}

/** Reuses a matching existing repository (by owner/name) instead of failing a retry. */
async function ensureGithubRepository(
  client: GitHubClient,
  owner: string,
  name: string,
  isPrivate: boolean,
): Promise<GithubPublishRepositoryStep> {
  try {
    try {
      const { data: existing } = await client.rest.repos.get({ owner, repo: name })
      return { status: 'found', url: existing.clone_url, fullName: existing.full_name }
    } catch (err) {
      if (!isNotFoundError(err)) throw err
    }
    const { data: viewer } = await client.rest.users.getAuthenticated()
    const response = viewer.login.toLowerCase() === owner.toLowerCase()
      ? await client.rest.repos.createForAuthenticatedUser({ name, private: isPrivate })
      : await client.rest.repos.createInOrg({ org: owner, name, private: isPrivate })
    return { status: 'created', url: response.data.clone_url, fullName: response.data.full_name }
  } catch (err) {
    return { status: 'failed', error: githubApiErrorMessage(err, 'Could not create the GitHub repository') }
  }
}

/** Adds a credential-free remote, or reuses one that already matches. Refuses
 *  to overwrite a remote pointing at a different repository. */
async function ensureGitRemote(
  cwd: string,
  remoteName: string,
  targetUrl: string,
  expectedFullName: string,
): Promise<GithubPublishRemoteStep> {
  const existingUrl = await runAsync('git', ['remote', 'get-url', remoteName], cwd).catch(() => null)
  if (existingUrl) {
    const parsed = parseRemoteUrl(existingUrl)
    // The host is part of the identity: `gitlab.com/acme/widgets` is a
    // different repository from `github.com/acme/widgets`, and publishing
    // must never treat one as the other.
    const matches = !!parsed
      && parsed.host.toLowerCase() === 'github.com'
      && `${parsed.owner}/${parsed.repo}`.toLowerCase() === expectedFullName.toLowerCase()
    if (!matches) {
      return { status: 'failed', error: `Remote "${remoteName}" already points to ${existingUrl}, not ${expectedFullName}.` }
    }
    return { status: 'existing', name: remoteName, url: existingUrl }
  }
  try {
    await runAsync('git', ['remote', 'add', remoteName, targetUrl], cwd)
    return { status: 'added', name: remoteName, url: targetUrl }
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message : String(err) }
  }
}

/** Pushes only when there is something to push — a freshly initialized
 *  repository with no commits publishes as a remote-only checkout. */
async function pushInitialCommits(
  cwd: string,
  remoteName: string,
  branch: string,
  protocol: 'https' | 'ssh',
  token: string | null,
): Promise<GithubPublishPushStep> {
  if (!await hasAnyCommit(cwd)) return { status: 'skipped_no_commits' }

  const isHttps = protocol === 'https'
  const askpass = isHttps && token ? await createGitAskpassHelper() : null
  const env = gitAuthEnv({ isHttps, token, askpassPath: askpass?.path ?? null })
  try {
    await runAsync('git', ['push', '-u', remoteName, branch], cwd, { env })
    return { status: 'pushed', branch }
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message : String(err) }
  } finally {
    if (askpass) await rm(askpass.directory, { recursive: true, force: true }).catch(() => {})
  }
}

export interface PublishRepositoryToGithubOptions extends GithubPublishRepositoryRequest {
  client: GitHubClient
  cwd: string
  /** Owner's GitHub OAuth token, used only for an HTTPS push's askpass helper. */
  token: string | null
}

/**
 * Creates or reuses a GitHub repository, adds a credential-free remote, and
 * pushes existing commits. Every stage resolves independently — a later
 * failure never hides an earlier stage's success (e.g. a created repository
 * URL survives a failed push, so the caller can show it and retry).
 */
export async function publishRepositoryToGithub(
  options: PublishRepositoryToGithubOptions,
): Promise<GithubPublishRepositoryResult> {
  const remoteName = options.remoteName?.trim() || 'origin'
  const repository = await ensureGithubRepository(options.client, options.owner, options.name, options.private)
  if (repository.status === 'failed') {
    return { success: false, repository, remote: { status: 'skipped' }, push: { status: 'skipped' } }
  }

  // GitHub hands back the HTTPS clone URL; the same retargeting the clone flow
  // uses turns it into the protocol the user picked.
  const remoteUrl = applyCloneProtocol(repository.url, options.protocol)
  const remote = await ensureGitRemote(options.cwd, remoteName, remoteUrl, repository.fullName)
  if (remote.status === 'failed') {
    return { success: false, repository, remote, push: { status: 'skipped' } }
  }

  const branch = await runAsync('git', ['symbolic-ref', '--short', 'HEAD'], options.cwd).catch(() => null)
  if (!branch) {
    return {
      success: false,
      repository,
      remote,
      push: { status: 'failed', error: 'This checkout has no branch to publish (detached HEAD).' },
    }
  }

  const push = await pushInitialCommits(options.cwd, remoteName, branch, options.protocol, options.token)
  return { success: push.status !== 'failed', repository, remote, push }
}

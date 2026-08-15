import { z } from 'zod'
import type { GitInitRepositoryResult, GithubPublishRepositoryResult, GitRepositoryStatus } from '../../../shared/types'
import type { SolusServer } from '../server'
import { createLogger } from '../../logger'
import { computeGitRepositoryStatus, initRepository } from '../../git/git-init'
import { publishRepositoryToGithub } from '../../git/github-publish'
import { GitHubAuth } from '../../providers/github/auth'
import { buildClient } from '../../providers/github/octokit'
import { loadGitHubAccessToken } from '../../providers/github/git-credential'
import { hasGithubAuth } from './setup-handlers'

const log = createLogger('main', 'git-publish-handlers')

const githubPublishRequestSchema = z.object({
  owner: z.string().trim().min(1),
  name: z.string().trim().min(1),
  private: z.boolean(),
  remoteName: z.string().trim().min(1).optional(),
  protocol: z.enum(['https', 'ssh']),
}).strict()

/** Initialize Git and Publish to GitHub — GitHub only, run on the selected host. */
export function registerGitPublishHandlers(server: SolusServer): void {
  server.register('gitRepositoryStatus', async (args): Promise<GitRepositoryStatus> => {
    const [cwd] = args
    return computeGitRepositoryStatus(cwd)
  })

  server.register('gitInitRepository', async (args): Promise<GitInitRepositoryResult> => {
    const [cwd] = args
    if (!cwd || cwd === '~') throw new Error('No folder is open for this session.')
    const status = await computeGitRepositoryStatus(cwd)
    if (status.isRepository) throw new Error('This folder is already a Git repository.')
    const result = await initRepository(cwd)
    log.info('git_repository_initialized', { cwd, defaultBranch: result.defaultBranch })
    return result
  })

  server.register('githubPublishRepository', async (args): Promise<GithubPublishRepositoryResult> => {
    const [ctx, request] = args
    const { owner, name, private: isPrivate, remoteName, protocol } = githubPublishRequestSchema.parse(request)
    const cwd = ctx.session.projectPath || ctx.session.workingDirectory
    if (!cwd || cwd === '~') throw new Error('No folder is open for this session.')
    if (!hasGithubAuth()) throw new Error('Connect GitHub on this host before publishing.')
    const status = await computeGitRepositoryStatus(cwd)
    if (!status.isRepository) throw new Error('Initialize Git before publishing to GitHub.')

    const client = await buildClient(new GitHubAuth())
    const result = await publishRepositoryToGithub({
      client,
      cwd,
      owner,
      name,
      private: isPrivate,
      remoteName,
      protocol,
      token: loadGitHubAccessToken(),
    })
    log.info('github_publish_repository_completed', { cwd, owner, name, success: result.success })
    return result
  })
}

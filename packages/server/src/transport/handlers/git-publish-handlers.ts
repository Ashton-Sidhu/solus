import { z } from 'zod'
import { projectScopeOf, type GitInitRepositoryResult, type GithubPublishRepositoryResult, type GitRepositoryStatus } from '@solus/contracts/types'
import type { SolusServer } from '../server'
import { createLogger } from '../../logger'
import { computeGitRepositoryStatus, initRepository } from '../../git/git-init'
import { publishRepositoryToGithub } from '../../git/github-publish'
import { clientFor } from '../../providers/github/octokit'
import { githubCredentialChain } from '../../providers/github/credentials'

const log = createLogger('main', 'git-publish-handlers')

const githubPublishRequestSchema = z.object({
  /** Omitted means "the account the checkout's credential authenticates as". */
  owner: z.string().trim().min(1).optional(),
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
    const cwd = projectScopeOf(ctx.session)
    if (!cwd || cwd === '~') throw new Error('No folder is open for this session.')
    const status = await computeGitRepositoryStatus(cwd)
    if (!status.isRepository) throw new Error('Initialize Git before publishing to GitHub.')

    // Publish is reachable from a dispatched session, whose checkout commits and
    // pushes as the paired device. Creating the repository as the host owner
    // would file the client's work under the wrong account, so the checkout's
    // own credential leads the chain.
    const [credential] = await githubCredentialChain('github.com', cwd)
    if (!credential) throw new Error('Connect GitHub on this host before publishing.')

    const result = await publishRepositoryToGithub({
      client: clientFor(credential),
      cwd,
      owner,
      name,
      private: isPrivate,
      remoteName,
      protocol,
      token: credential.token,
    })
    log.info('github_publish_repository_completed', { cwd, owner, name, success: result.success, credential: credential.source })
    return result
  })
}

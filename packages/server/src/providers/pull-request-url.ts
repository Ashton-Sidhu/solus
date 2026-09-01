import { parseGitHubPullRequestUrl } from '@solus/contracts/providers'
import { resolveRepoRef } from '../git/git-helpers'
import { runAsync } from '../git/exec'
import { createLogger } from '../logger'
import { providerForRepo } from './registry'
import { withAdapterCliFallback } from './adapter-cli-fallback'

function validatedPullRequestUrl(value: string, number: number): string {
  const parsed = parseGitHubPullRequestUrl(value)
  if (!parsed || parsed.number !== number) {
    throw new Error(`GitHub returned an invalid URL for pull request #${number}.`)
  }
  return parsed.url
}

/** Resolve and validate one canonical PR URL without changing local git state. */
export async function resolvePullRequestUrl(cwd: string, number: number): Promise<string> {
  const log = createLogger('main', 'pull-request-url').child({ cwd, prNumber: number })
  const repo = await resolveRepoRef(cwd)
  const provider = repo ? providerForRepo(repo) : null

  log.info('pr_url_resolution_started', {
    hasRepository: !!repo,
    hasProviderAdapter: !!provider,
  })
  const url = await withAdapterCliFallback({
    operation: 'resolve_pull_request_url',
    log,
    adapter: repo && provider
      ? async () => (await provider.review.getPullRequest(repo, number)).url
      : null,
    cli: async () => validatedPullRequestUrl(
      await runAsync('gh', ['pr', 'view', String(number), '--json', 'url', '--jq', '.url'], cwd, {
        timeout: 10_000,
      }),
      number,
    ),
  })
  log.info('pr_url_resolution_succeeded', { url })
  return url
}

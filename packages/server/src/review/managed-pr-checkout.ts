import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { PrCheckoutContext } from '@solus/contracts/types'
import type { RepoRef } from '../providers/types'
import type { ReviewTarget } from '@solus/contracts/review'
import { runAsync } from '../git/exec'
import { createGitAskpassHelper, gitAuthEnv } from '../git/git-auth-env'
import { createLogger } from '../logger'
import { dataDir } from '../platform/paths'
import { ghAuthToken } from '../providers/github/gh-cli'
import { loadToken } from '../providers/github/token-store'

const log = createLogger('review', 'managed-pr-checkout.ts')

type PrTarget = Extract<ReviewTarget, { kind: 'pr' }> & { baseSha: string; headSha: string }

export interface ManagedPrCheckoutOptions {
  root?: string
  cloneUrl?: string
}

export function managedPrCheckoutPath(
  repo: RepoRef,
  target: PrTarget,
  root = join(dataDir(), 'review-checkouts'),
): string {
  const identity = `${repo.host.toLowerCase()}/${repo.owner.toLowerCase()}/${repo.repo.toLowerCase()}/${target.number}/${target.baseSha}/${target.headSha}`
  return join(root, createHash('sha256').update(identity).digest('hex'))
}

function githubCloneUrl(repo: RepoRef): string {
  return `https://${repo.host}/${repo.owner}/${repo.repo}.git`
}

function storedGithubToken(): string | null {
  try {
    return loadToken()?.accessToken ?? null
  } catch {
    return null
  }
}

async function reusableCheckout(
  checkoutPath: string,
  target: PrTarget,
): Promise<PrCheckoutContext | null> {
  if (!existsSync(join(checkoutPath, '.git'))) return null
  const [headSha, baseSha, shallow] = await Promise.all([
    runAsync('git', ['rev-parse', 'HEAD'], checkoutPath).catch(() => ''),
    runAsync('git', ['rev-parse', 'refs/solus/review/base'], checkoutPath).catch(() => ''),
    runAsync('git', ['rev-parse', '--is-shallow-repository'], checkoutPath).catch(() => ''),
  ])
  if (headSha !== target.headSha || baseSha !== target.baseSha || shallow !== 'true') return null
  return {
    worktreePath: checkoutPath,
    branch: `solus/review/pr-${target.number}`,
    baseSha,
    headSha,
  }
}

async function cleanLegacyReviewArtifacts(checkoutPath: string): Promise<void> {
  try {
    // Managed checkouts are host-owned exact revisions. Remove only untracked
    // Solus guide files left by older versions; tracked repository content is
    // never touched by git clean.
    await runAsync('git', ['clean', '-fdx', '--', '.solus/review'], checkoutPath)
  } catch (error) {
    log.warn('managed_pr_checkout_legacy_review_cleanup_failed', {
      checkoutPath,
      error: String(error),
    })
  }
}

/**
 * Materialize an exact external pull-request revision in host-managed storage.
 * The initial clone and both exact revision fetches stay shallow. Review agents
 * need the two trees, not the repository's full history.
 */
export async function ensureManagedPrCheckout(
  repo: RepoRef,
  target: PrTarget,
  options: ManagedPrCheckoutOptions = {},
): Promise<PrCheckoutContext> {
  const checkoutPath = managedPrCheckoutPath(repo, target, options.root)
  const existing = await reusableCheckout(checkoutPath, target)
  if (existing) {
    await cleanLegacyReviewArtifacts(checkoutPath)
    log.info('managed_pr_checkout_reused', {
      host: repo.host,
      owner: repo.owner,
      repo: repo.repo,
      prNumber: target.number,
      headSha: target.headSha,
      checkoutPath,
    })
    return existing
  }

  // This directory is derived only from the review identity and is owned by
  // this helper. A prior failed clone can therefore be replaced safely.
  await rm(checkoutPath, { recursive: true, force: true })
  await mkdir(dirname(checkoutPath), { recursive: true })

  const cloneUrl = options.cloneUrl ?? githubCloneUrl(repo)
  const isHttps = cloneUrl.startsWith('https://')
  const token = isHttps
    ? storedGithubToken() ?? await ghAuthToken(repo.host).catch(() => null)
    : null
  const askpass = token ? await createGitAskpassHelper() : null
  const env = gitAuthEnv({ isHttps, token, askpassPath: askpass?.path ?? null })
  try {
    await runAsync(
      'git',
      ['clone', '--no-checkout', '--depth=1', cloneUrl, checkoutPath],
      dirname(checkoutPath),
      { env, timeout: 120_000 },
    )
    await runAsync(
      'git',
      ['fetch', '--depth=1', '--force', 'origin', `${target.baseSha}:refs/solus/review/base`],
      checkoutPath,
      { env, timeout: 120_000 },
    )
    await runAsync(
      'git',
      ['fetch', '--depth=1', '--force', 'origin', `${target.headSha}:refs/solus/review/head`],
      checkoutPath,
      { env, timeout: 120_000 },
    )
    const branch = `solus/review/pr-${target.number}`
    await runAsync('git', ['checkout', '-B', branch, 'refs/solus/review/head'], checkoutPath, { env })

    const prepared = await reusableCheckout(checkoutPath, target)
    if (!prepared) throw new Error('The managed checkout did not match the requested pull request revision.')
    log.info('managed_pr_checkout_created', {
      host: repo.host,
      owner: repo.owner,
      repo: repo.repo,
      prNumber: target.number,
      headSha: target.headSha,
      checkoutPath,
    })
    return prepared
  } catch (error) {
    await rm(checkoutPath, { recursive: true, force: true }).catch(() => {})
    throw error
  } finally {
    if (askpass) await rm(askpass.directory, { recursive: true, force: true }).catch(() => {})
  }
}

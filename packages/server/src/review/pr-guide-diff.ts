import type { PrDiffFileContents, PrDiffFileContentsRequest, PrDiffRequest, PrDiffSlice, RepoRef } from '@solus/contracts/providers'
import { runAsync } from '../git/exec'
import { ensureManagedPrCheckout } from './managed-pr-checkout'

type GuideRevision = Pick<PrDiffRequest, 'number' | 'baseSha' | 'headSha'>
const SHA = /^[a-f0-9]{40,64}$/i

/** Read a guide's immutable comparison, never the active chat's checkout or
 * the PR's newer HEAD. The same path is used by remote clients. */
async function guideCheckout(repo: RepoRef, request: GuideRevision): Promise<string> {
  if (!SHA.test(request.baseSha) || !SHA.test(request.headSha)) {
    throw new Error('The guide does not have a valid commit comparison. Regenerate it.')
  }
  const checkout = await ensureManagedPrCheckout(repo, { kind: 'pr', ...repo, ...request })
  return checkout.worktreePath
}

export async function readPrGuidePatch(repo: RepoRef, request: PrDiffRequest): Promise<PrDiffSlice> {
  const cwd = await guideCheckout(repo, request)
  return readGuidePatchAt(cwd, request)
}

export async function readGuidePatchAt(cwd: string, request: GuideRevision): Promise<PrDiffSlice> {
  const patch = await runAsync('git', [
    '-c', 'core.quotepath=false', 'diff', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/',
    request.baseSha, request.headSha, '--',
  ], cwd, { maxBuffer: 50 * 1024 * 1024, raw: true })
  return { patch, truncated: false, nextCursor: null }
}

export async function readPrGuideFileContents(repo: RepoRef, request: PrDiffFileContentsRequest): Promise<PrDiffFileContents> {
  const cwd = await guideCheckout(repo, request)
  return readGuideFileContentsAt(cwd, request)
}

export async function readGuideFileContentsAt(cwd: string, request: PrDiffFileContentsRequest): Promise<PrDiffFileContents> {
  const read = (sha: string, path: string) => runAsync('git', ['show', `${sha}:${path}`], cwd, {
    maxBuffer: 20 * 1024 * 1024,
    raw: true,
  })
  const [oldContents, newContents] = await Promise.all([
    request.changeType === 'new' ? '' : read(request.baseSha, request.oldPath),
    request.changeType === 'deleted' ? '' : read(request.headSha, request.newPath),
  ])
  return { oldContents, newContents }
}

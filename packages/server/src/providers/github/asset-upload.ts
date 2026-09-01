import { readFile, stat } from 'fs/promises'
import { z } from 'zod'
import { buildClient } from './octokit'
import { GitHubAuth } from './auth'
import { storedAssetPath } from '../../server/asset-paths'
import { createLogger } from '../../logger'

const log = createLogger('main', 'github-asset-upload')

/**
 * The upload endpoint GitHub's own command-line client uses for `--attach`
 * (cli/cli#14180). It is not in the REST reference, so every rule below is
 * pinned from that implementation rather than inferred, and every failure is
 * mapped to a reason a caller can act on.
 */
const UPLOAD_ORIGIN = 'https://uploads.github.com'

/** The whole of the success body: the URL to reference from Markdown. */
const uploadResponseSchema = z.object({ url: z.string().min(1) })

const MEGABYTE = 1024 * 1024

export type GithubAssetKind = 'image' | 'video'

interface UploadableAssetType {
  contentType: string
  maxBytes: number
  kind: GithubAssetKind
}

/** What the endpoint accepts. An extension outside this table is refused before
 *  a request, because a mismatch between name and content type is a 422. */
export const GITHUB_UPLOADABLE_ASSETS = new Map<string, UploadableAssetType>([
  ['png', { contentType: 'image/png', maxBytes: 10 * MEGABYTE, kind: 'image' }],
  ['jpg', { contentType: 'image/jpeg', maxBytes: 10 * MEGABYTE, kind: 'image' }],
  ['jpeg', { contentType: 'image/jpeg', maxBytes: 10 * MEGABYTE, kind: 'image' }],
  ['gif', { contentType: 'image/gif', maxBytes: 10 * MEGABYTE, kind: 'image' }],
  ['webp', { contentType: 'image/webp', maxBytes: 10 * MEGABYTE, kind: 'image' }],
  ['svg', { contentType: 'image/svg+xml', maxBytes: 10 * MEGABYTE, kind: 'image' }],
  ['mp4', { contentType: 'video/mp4', maxBytes: 100 * MEGABYTE, kind: 'video' }],
  ['mov', { contentType: 'video/quicktime', maxBytes: 100 * MEGABYTE, kind: 'video' }],
])

/** Repository permissions the endpoint accepts. READ and TRIAGE get a 404. */
const UPLOAD_PERMISSIONS = new Set(['admin', 'maintain', 'write'])

export type GithubAssetUploadReason =
  | 'permission'
  | 'rejected-file'
  | 'unsupported-file'
  | 'unsupported-token'
  | 'transport'

export class GithubAssetUploadError extends Error {
  readonly reason: GithubAssetUploadReason

  constructor(reason: GithubAssetUploadReason, message: string) {
    super(message)
    this.name = 'GithubAssetUploadError'
    this.reason = reason
  }
}

export interface GithubUploadTarget {
  repositoryId: number
  permission: string
}

// One repository id and permission per owner/repo for the process lifetime. Both
// change about as often as a repository is renamed, and a stale hit fails closed
// with the 404 the caller already handles.
const targetCache = new Map<string, GithubUploadTarget>()

/**
 * Read the numeric repository id and the caller's permission, which the endpoint
 * needs and validates. `permissions` is present because the request is
 * authenticated as a user.
 */
export async function resolveUploadTarget(owner: string, repo: string): Promise<GithubUploadTarget> {
  const key = `${owner}/${repo}`
  const cached = targetCache.get(key)
  if (cached) return cached

  const { rest } = await buildClient(new GitHubAuth())
  const { data } = await rest.repos.get({ owner, repo })
  const permissions = data.permissions
  const permission = permissions?.admin
    ? 'admin'
    : permissions?.maintain
      ? 'maintain'
      : permissions?.push
        ? 'write'
        : 'read'
  const target = { repositoryId: data.id, permission }
  targetCache.set(key, target)
  return target
}

/** Forget a cached repository, so a permission grant takes effect without a restart. */
export function forgetUploadTarget(owner: string, repo: string): void {
  targetCache.delete(`${owner}/${repo}`)
}

/**
 * Everything an upload needs, checked before a byte is read. A caller that gets
 * past this has a request worth sending, which matters because an upload cannot
 * be undone and a rejected one must not have cost the user a comment.
 */
function assertCanUpload(target: GithubUploadTarget, assetType: UploadableAssetType, size: number): void {
  if (target.repositoryId <= 0) {
    throw new GithubAssetUploadError('permission', 'Solus could not identify the repository to attach this file to.')
  }
  if (!UPLOAD_PERMISSIONS.has(target.permission)) {
    throw new GithubAssetUploadError('permission', 'Attaching files needs write access to the repository.')
  }
  if (size === 0) {
    throw new GithubAssetUploadError('unsupported-file', 'The file is empty.')
  }
  if (size > assetType.maxBytes) {
    const limit = Math.round(assetType.maxBytes / MEGABYTE)
    throw new GithubAssetUploadError('unsupported-file', `GitHub accepts ${assetType.kind}s up to ${limit} MB.`)
  }
}

function assetTypeFor(assetId: string): UploadableAssetType {
  const extension = assetId.split('.').pop() ?? ''
  const assetType = GITHUB_UPLOADABLE_ASSETS.get(extension)
  if (!assetType) {
    throw new GithubAssetUploadError('unsupported-file', `GitHub does not accept .${extension} attachments.`)
  }
  return assetType
}

/**
 * Send one stored asset's bytes and return the URL to reference from Markdown.
 *
 * This is a hand-built request rather than an Octokit call for the same reason
 * the GitHub CLI builds it by hand: the endpoint requires `Content-Type` and
 * `Content-Length` per request, and the REST client sets neither.
 */
export async function uploadGithubAsset(
  target: GithubUploadTarget,
  assetId: string,
  options: { assetsDir?: string } = {},
): Promise<string> {
  const assetType = assetTypeFor(assetId)
  const path = storedAssetPath(assetId, options.assetsDir)
  const size = (await stat(path)).size
  assertCanUpload(target, assetType, size)

  const token = await new GitHubAuth().getAccessToken()
  const url = new URL('/user-attachments/assets', UPLOAD_ORIGIN)
  // The asset id is used as the name because its extension always agrees with
  // the content type. A user-facing label does not, and a disagreement is a 422.
  url.searchParams.set('name', assetId)
  url.searchParams.set('content_type', assetType.contentType)
  url.searchParams.set('repository_id', String(target.repositoryId))

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/octet-stream',
        accept: 'application/vnd.github+json',
        'user-agent': 'Solus',
      },
      body: await readFile(path),
    })
  } catch (error) {
    throw new GithubAssetUploadError('transport', `Solus could not reach GitHub to upload the attachment: ${String(error)}`)
  }

  if (!response.ok) throw await uploadFailure(response)

  const parsed = uploadResponseSchema.safeParse(await response.json().catch(() => null))
  // A 2xx with no URL is a failure: nothing can reference what was uploaded.
  if (!parsed.success) {
    throw new GithubAssetUploadError('transport', 'GitHub accepted the attachment but returned no URL for it.')
  }
  log.info('github_asset_uploaded', { assetId, repositoryId: target.repositoryId })
  return parsed.data.url
}

async function uploadFailure(response: Response): Promise<GithubAssetUploadError> {
  const detail = await response.text().catch(() => '')
  switch (response.status) {
    case 404:
      // The endpoint answers 404, not 403, when the token cannot write, so the
      // status alone points at the wrong problem.
      return new GithubAssetUploadError('permission', 'Attaching files needs write access to the repository.')
    case 422:
      return new GithubAssetUploadError('rejected-file', `GitHub rejected the attachment. ${detail}`.trim())
    default:
      return new GithubAssetUploadError('transport', `GitHub refused the upload with status ${response.status}. ${detail}`.trim())
  }
}

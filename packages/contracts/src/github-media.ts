/**
 * Media that a pull request body points at on GitHub's own hosts.
 * Adapted from T3 Code (MIT, pingdotgg/t3code@e2e95a39d,
 * packages/shared/src/githubMedia.ts).
 *
 * In a private repository GitHub answers a request without a credential for
 * this media with 404. A screenshot dropped into a description becomes
 * `github.com/user-attachments/assets/<id>`, and a file committed with the code
 * becomes a `raw.githubusercontent.com` path. A client has no GitHub
 * credential, so it shows a broken image. The host fetches these with its own
 * credential and serves the bytes through a signed URL (`assetCreateUrl` with
 * `githubMediaUrl`).
 *
 * Only hosts where the credential decides the answer are here. A
 * `private-user-images.githubusercontent.com` or `objects.githubusercontent.com`
 * URL already carries its own short-lived signature, and a token does nothing
 * for it after that signature expires. Clients load those directly.
 *
 * Clients and the host use this one function, so a client rewrites exactly the
 * URLs that the host agrees to sign.
 */

const RAW_HOST = 'raw.githubusercontent.com'
/** Git LFS pointers resolve here. The bytes of an LFS-tracked screenshot are here. */
const LFS_HOST = 'media.githubusercontent.com'
const ATTACHMENT_PATH_PATTERN = /^\/user-attachments\/assets\/[\w-]+$/u
/** The form GitHub wrote into a body before `user-attachments`. Older descriptions still have it. */
const LEGACY_ATTACHMENT_PATH_PATTERN = /^\/[^/]+\/[^/]+\/assets\/\d+\/[\w-]+$/u
/** `blob` and `raw` both address file bytes. The raw host is where a token works. */
const REPOSITORY_FILE_PATTERN = /^\/([^/]+)\/([^/]+)\/(?:raw|blob)\/(.*[^/])$/u

/**
 * The URL to fetch with a GitHub credential for `source`, or null when
 * `source` is not GitHub-hosted media. A client loads a null source directly.
 */
export function githubMediaFetchUrl(source: string): string | null {
  let url: URL
  try {
    url = new URL(source)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  const host = url.hostname.toLowerCase()
  // Port, user information and fragment do not change which bytes GitHub serves.
  if (host === RAW_HOST || host === LFS_HOST) return `https://${host}${url.pathname}${url.search}`
  if (host !== 'github.com' && host !== 'www.github.com') return null
  if (ATTACHMENT_PATH_PATTERN.test(url.pathname) || LEGACY_ATTACHMENT_PATH_PATTERN.test(url.pathname)) {
    return `https://github.com${url.pathname}`
  }
  const repositoryFile = REPOSITORY_FILE_PATTERN.exec(url.pathname)
  // `?raw=true` is how the web page asks for the bytes. The raw host needs no query.
  return repositoryFile ? `https://${RAW_HOST}/${repositoryFile[1]}/${repositoryFile[2]}/${repositoryFile[3]}` : null
}

/** The last path segment, which names the file when GitHub gives no media type. */
export function githubMediaFileName(fetchUrl: string): string {
  const segment = new URL(fetchUrl).pathname.split('/').pop() ?? ''
  let decoded: string
  try {
    decoded = decodeURIComponent(segment)
  } catch {
    decoded = segment
  }
  const name = decoded.replace(/[\p{Cc}\\/]/gu, '')
  return name.length > 0 ? name : 'github-media'
}

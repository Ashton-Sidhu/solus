import { githubMediaFetchUrl } from '@solus/contracts/github-media'
import type { IpcContext } from '@solus/contracts/types'
import { resolveHostMediaUrl } from '../files/host-media-url'
import type { HostConnection } from '../hosts/host-connections'

/**
 * The address an image or video of a pull request body loads from. GitHub
 * media (`githubMediaFetchUrl`) in a private repository needs a GitHub
 * credential, which only the host has: the host fetches it and signs a URL on
 * its own origin, kept until shortly before it expires. Any other address,
 * a host that cannot sign it, or a failed signature loads the URL directly.
 */
export async function pullRequestMediaUrl(connection: HostConnection | null, url: string, ctx: IpcContext, refresh = false): Promise<string> {
  const githubMediaUrl = githubMediaFetchUrl(url)
  if (!githubMediaUrl || !connection || connection.state.phase !== 'connected') return url
  try {
    return await resolveHostMediaUrl(connection, { githubMediaUrl, ctx }, refresh)
  } catch {
    return url
  }
}

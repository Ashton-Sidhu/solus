import type { BrowserDiscoveredTarget } from '@solus/contracts/browser-types'
import { runningServers } from '../host/running-servers/registry'

/** Owned listeners are offered without probing; explicit API URLs are offered too. */
export async function discoverBrowserTargets(): Promise<BrowserDiscoveredTarget[]> {
  const servers = await runningServers().list()
  return servers.flatMap((server) => server.endpoints
    .map((endpoint) => ({
      url: endpoint.url,
      port: endpoint.port,
      pid: server.process.pid,
      cwd: server.process.workingDirectory ?? '',
      worktreePath: server.location.worktreePath ?? undefined,
      projectRoot: server.location.projectRoot ?? undefined,
      branch: server.location.branch ?? undefined,
      title: endpoint.response?.pageTitle ?? undefined,
    })))
}

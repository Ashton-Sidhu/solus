import { isInsideHostPath, sameHostPath } from './host-path'

/** Live facts from one host. None of this state is persisted. */
export interface RunningServer {
  /** Opaque process identity, scoped to this host. */
  serverId: string
  process: { pid: number; name: string; workingDirectory: string | null }
  location: { projectRoot: string | null; worktreePath: string | null; branch: string | null }
  /** Attribution is separate from location and does not grant permission to stop. */
  startedBy: { kind: 'agent'; sessionId: string | null } | { kind: 'terminal'; terminalId: string; sessionId: string | null } | { kind: 'configured' } | { kind: 'unknown' }
  endpoints: ServerEndpoint[]
  actions: { canStop: boolean }
}

export interface ServerEndpoint {
  endpointId: string
  address: string
  port: number
  url: string
  /** Null until an explicit URL was checked. Discovery never probes a process. */
  response: {
    protocol: 'http' | 'https'
    statusCode: number
    contentType: string | null
    pageTitle: string | null
  } | null
}

export type StopRunningServerResult =
  | { status: 'stopped' }
  | { status: 'already-exited' }
  | { status: 'refused'; reason: 'identity-changed' | 'not-permitted' | 'shared-group' | 'still-running' }

/** The tag children inherit, including detached commands. Never an authorization token. */
export const RUNNING_SERVER_SESSION_ENV = 'SOLUS_SESSION_ID'
export const RUNNING_SERVER_TERMINAL_ENV = 'SOLUS_TERMINAL_ID'
export const SERVER_LIST_PAGE_SIZE = 4

/** Both clients group by checkout, not by the session that launched a process. */
export function serversForCheckout(servers: readonly RunningServer[], checkoutPath: string | null, checkoutRoot?: string): RunningServer[] {
  if (!checkoutPath) return servers.filter((server) => server.location.worktreePath === null)
  return servers.filter((server) => {
    const root = server.location.worktreePath ?? server.process.workingDirectory
    if (!root) return false
    if (checkoutRoot) return sameHostPath(root, checkoutRoot)
    return isInsideHostPath(root, checkoutPath) || (!server.location.worktreePath && isInsideHostPath(checkoutPath, root))
  })
}

export function serverEndpointLabel(endpoint: ServerEndpoint): string {
  const type = endpoint.response?.contentType?.split(';')[0] ?? ''
  const format = type.includes('json') ? 'JSON' : type.includes('html') ? 'HTML' : endpoint.response ? 'HTTP' : 'TCP'
  return `:${endpoint.port} · ${format}`
}

export interface RunningServerGroup {
  checkoutPath: string | null
  servers: RunningServer[]
}

export function runningServerGroups(servers: readonly RunningServer[]): RunningServerGroup[] {
  const groups = new Map<string | null, RunningServer[]>()
  for (const server of servers) {
    const path = server.location.worktreePath ?? server.process.workingDirectory
    const group = groups.get(path)
    if (group) group.push(server)
    else groups.set(path, [server])
  }
  return [...groups].map(([checkoutPath, servers]) => ({ checkoutPath, servers }))
}

export interface RunningServerRow { server: RunningServer; endpoint: ServerEndpoint; checkoutPath: string | null }
export function runningServerRows(servers: readonly RunningServer[]): RunningServerRow[] {
  return runningServerGroups(servers).flatMap((group) => group.servers.flatMap((server) => server.endpoints.map((endpoint) => ({ server, endpoint, checkoutPath: group.checkoutPath }))))
}
export function serverSourceLabel(server: RunningServer): string {
  return server.startedBy.kind === 'agent' ? 'Agent' : server.startedBy.kind === 'terminal' ? 'Terminal' : 'Configured'
}
export function serverUrlsFromText(text: string): string[] { return [...new Set(text.split('\n').map((line) => line.trim()).filter(Boolean))] }

/** Explicit HTTP endpoints, kept in .solus/config.json for this checkout. */
export interface RunningServerTunnel { relativeUrl: string; expiresAt: number }
export interface NativeServerForward { forwardId: string; endpointKey: string; localPort: number; url: string }
export interface NativeServerForwardRequest { endpointKey: string; tunnelUrl: string; targetUrl: string; expiresAt: number }

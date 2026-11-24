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
  | { status: 'refused'; reason: StopRefusalReason }

export type StopRefusalReason = 'identity-changed' | 'not-permitted' | 'shared-group' | 'still-running'

/** What a refused Stop tells the person, the same on every client. */
export function stopRefusalText(reason: StopRefusalReason): string {
  switch (reason) {
    case 'identity-changed': return 'The process changed. Read the server list again.'
    case 'shared-group': return 'Its process group also holds a process that Solus does not stop, such as an agent, a shell, or a process from another session.'
    case 'still-running': return 'The process did not exit after Solus sent the stop signals.'
    case 'not-permitted': return 'Solus does not stop this process.'
  }
}

/** The tag children inherit, including detached commands. Never an authorization token. */
export const RUNNING_SERVER_SESSION_ENV = 'SOLUS_SESSION_ID'
export const RUNNING_SERVER_TERMINAL_ENV = 'SOLUS_TERMINAL_ID'

export function serverUrlsFromText(text: string): string[] { return [...new Set(text.split('\n').map((line) => line.trim()).filter(Boolean))] }

export const RUNNING_SERVER_TUNNEL_PATH = '/api/running-servers/tunnel/'
export function isRunningServerTunnelPath(path: string): boolean {
  return path.startsWith(RUNNING_SERVER_TUNNEL_PATH) && /^[\w-]{43}$/.test(path.slice(RUNNING_SERVER_TUNNEL_PATH.length))
}

/** A capability addressed to the connected host and scoped to one TCP endpoint. */
export interface RunningServerTunnel { relativeUrl: string; expiresAt: number }
export interface NativeServerForward { forwardId: string; endpointKey: string; localPort: number; url: string }
export interface NativeServerForwardRequest { endpointKey: string; tunnelUrl: string; targetUrl: string; expiresAt: number }

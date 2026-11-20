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

export function serverUrlsFromText(text: string): string[] { return [...new Set(text.split('\n').map((line) => line.trim()).filter(Boolean))] }

/** Explicit HTTP endpoints, kept in .solus/config.json for this checkout. */
export interface RunningServerTunnel { relativeUrl: string; expiresAt: number }
export interface NativeServerForward { forwardId: string; endpointKey: string; localPort: number; url: string }
export interface NativeServerForwardRequest { endpointKey: string; tunnelUrl: string; targetUrl: string; expiresAt: number }

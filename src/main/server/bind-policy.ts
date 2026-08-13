export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

export function resolveEffectiveServerOptions(opts: ServerBindOptions = {}): EffectiveServerOptions {
  const host = opts.host ?? process.env.SOLUS_HOST ?? (opts.remoteAccess ? '0.0.0.0' : '127.0.0.1')
  const requireAuth = isLoopbackHost(host) ? (opts.requireAuth ?? false) : true
  return { host, requireAuth }
}
export interface ServerBindOptions {
  host?: string
  requireAuth?: boolean
  remoteAccess?: boolean
}

export interface EffectiveServerOptions {
  host: string
  requireAuth: boolean
}

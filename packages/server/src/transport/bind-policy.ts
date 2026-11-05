export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

export function resolveEffectiveServerOptions(opts: ServerBindOptions = {}): EffectiveServerOptions {
  const host = opts.host ?? process.env.SOLUS_HOST ?? (opts.remoteAccess && opts.remoteAllowed !== false ? '0.0.0.0' : '127.0.0.1')
  // A policy without remote access never listens beyond loopback, not even briefly (plans/030 §6.7).
  if (opts.remoteAllowed === false && !isLoopbackHost(host)) {
    throw new Error(`${opts.refusal ?? 'A policy does not allow remote access'}, so the server cannot listen on ${host}. Remove SOLUS_HOST or the host option.`)
  }
  const requireAuth = isLoopbackHost(host) ? (opts.requireAuth ?? false) : true
  return { host, requireAuth }
}
export interface ServerBindOptions {
  host?: string
  requireAuth?: boolean
  remoteAccess?: boolean
  /** false: a policy turns remote access off, and only a loopback bind is allowed. */
  remoteAllowed?: boolean
  /** The policy's refusal text, for the error. */
  refusal?: string
}

export interface EffectiveServerOptions {
  host: string
  requireAuth: boolean
}

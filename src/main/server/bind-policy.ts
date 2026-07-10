export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

export function resolveEffectiveServerOptions(opts: { host?: string; requireAuth?: boolean; remoteAccess?: boolean } = {}): { host: string; requireAuth: boolean } {
  const host = opts.host ?? process.env.SOLUS_HOST ?? (opts.remoteAccess ? '0.0.0.0' : '127.0.0.1')
  const requireAuth = isLoopbackHost(host) ? (opts.requireAuth ?? false) : true
  return { host, requireAuth }
}

export interface Endpoint {
  kind?: string
  host: string
  port: number
}

export interface FlagSpec {
  set?: () => void
  value?: (value: string) => void
  missingValueMessage?: string
}

export interface GitCredentialAction<T> {
  action: T
  args: string[]
}

const GIT_CREDENTIAL_VALUE_FLAGS = new Set(['--data-dir', '--delegation'])

/**
 * Git appends the operation to whatever it finds in `credential.*.helper`, so a
 * helper configured with flags is invoked as `… --delegation <id> get`. The
 * action can therefore sit anywhere that is not already a flag's value.
 */
export function extractGitCredentialAction<T>(
  args: string[],
  coerceAction: (value: string | undefined) => T,
): GitCredentialAction<T> {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const equalsAt = arg.indexOf('=')
    const flag = equalsAt === -1 ? arg : arg.slice(0, equalsAt)
    if (equalsAt === -1 && GIT_CREDENTIAL_VALUE_FLAGS.has(flag)) {
      i++
      continue
    }
    if (arg === 'get' || arg === 'store' || arg === 'erase') {
      const remainingArgs = args.slice()
      remainingArgs.splice(i, 1)
      return { action: coerceAction(arg), args: remainingArgs }
    }
  }
  return { action: coerceAction(undefined), args }
}

export function parseFlags(args: string[], spec: Record<string, FlagSpec>, unknownOption: (arg: string) => Error): void {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const equalsAt = arg.indexOf('=')
    const flag = equalsAt === -1 ? arg : arg.slice(0, equalsAt)
    const entry = spec[flag]
    if (!entry || (equalsAt !== -1 && !entry.value)) throw unknownOption(arg)
    if (!entry.value) entry.set!()
    else {
      const value = equalsAt === -1 ? args[++i] : arg.slice(equalsAt + 1)
      if (!value && equalsAt === -1) throw new Error(entry.missingValueMessage ?? `${flag} requires a value`)
      entry.value(value)
    }
  }
}

export function parsePort(value: string, option: string): number {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`Invalid ${option}: ${value}`)
  return port
}

export function hostForUrl(host: string): string {
  if (!host || host === '0.0.0.0' || host === '::') return '127.0.0.1'
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

export function bestEndpoint<T extends Endpoint>(endpoints: T[]): T | null {
  const valid = endpoints.filter((endpoint) => endpoint.host.trim().length > 0 && Number.isInteger(endpoint.port))
  return valid.find((endpoint) => endpoint.kind === 'tailnet') ??
    valid.find((endpoint) => endpoint.kind === 'lan') ??
    valid[0] ??
    null
}

export function formatClaimBlock(claimUrl: string, code: string, expiresAt: number, fingerprint: string): string[] {
  const ttlMinutes = Math.max(0, Math.ceil((expiresAt - Date.now()) / 60_000))
  return [
    `Claim URL: ${claimUrl}`,
    `Code: ${code}`,
    `Fingerprint: ${fingerprint}`,
    `Expires in: ${ttlMinutes} minute${ttlMinutes === 1 ? '' : 's'}`,
  ]
}

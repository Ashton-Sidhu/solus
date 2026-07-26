import { loadToken } from './token-store'

/**
 * `solus git-credential` speaks git's credential protocol so a host that cloned
 * with a one-off askpass can still fetch and push afterwards. Git writes
 * `key=value` lines on stdin, then a blank line; a `get` answers with the same
 * shape on stdout. Anything we can't answer prints nothing, which tells git to
 * fall through to the next helper rather than fail.
 */

/** Only github.com is served: the stored token is a GitHub OAuth user token. */
const SUPPORTED_HOST = 'github.com'
/** Git's own convention for "this password is a token, not a user password". */
const TOKEN_USERNAME = 'x-access-token'

export type GitCredentialAction = 'get' | 'store' | 'erase'

export function coerceGitCredentialAction(value: string | undefined): GitCredentialAction {
  if (value === 'get' || value === 'store' || value === 'erase') return value
  throw new Error('Unknown git-credential action. Expected: get, store or erase.')
}

export function parseCredentialRequest(input: string): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const line of input.split('\n')) {
    if (!line.trim()) continue
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim()
  }
  return fields
}

/**
 * The credential git should use, or null when this host has nothing to offer for
 * the request — an unknown host, a non-HTTPS protocol, or no stored token.
 */
export function credentialFor(
  fields: Record<string, string>,
  token: string | null,
): { username: string; password: string } | null {
  if (!token) return null
  if (fields.protocol && fields.protocol !== 'https') return null
  if (fields.host && fields.host !== SUPPORTED_HOST) return null
  return { username: TOKEN_USERNAME, password: token }
}

export function formatCredentialResponse(credential: { username: string; password: string }): string {
  return `username=${credential.username}\npassword=${credential.password}\n`
}

export async function runGitCredentialHelper(
  action: GitCredentialAction,
  stdin: NodeJS.ReadableStream,
  stdout: NodeJS.WritableStream,
): Promise<void> {
  // `store` and `erase` are no-ops: the token's lifecycle belongs to Solus's
  // keyring, and git must not be able to delete it.
  if (action !== 'get') return

  const fields = parseCredentialRequest(await readAll(stdin))
  const token = loadTokenSafely()
  const credential = credentialFor(fields, token)
  if (credential) stdout.write(formatCredentialResponse(credential))
}

function loadTokenSafely(): string | null {
  try {
    return loadToken()?.accessToken ?? null
  } catch {
    return null
  }
}

function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    stream.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))))
    stream.on('error', reject)
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

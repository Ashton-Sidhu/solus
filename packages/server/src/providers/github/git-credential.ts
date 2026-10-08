import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { text } from 'node:stream/consumers'
import { z } from 'zod'
import { hostCliEnv } from '../../cli-env'
import { readHostCredential } from '../../vault/provider-credentials'
import { delegatedGithubToken } from './credentials'
import { githubStoredTokenSchema } from './token-store'

/**
 * `solus git-credential` speaks git's credential protocol so a host that cloned
 * with a one-off askpass can still fetch and push afterwards. Git writes
 * `key=value` lines on stdin, then a blank line; a `get` answers with the same
 * shape on stdout. Anything we can't answer prints nothing, which tells git to
 * fall through to the next helper rather than fail.
 */

/** The git config key whose helper answers github.com HTTPS credentials. */
export const GITHUB_CREDENTIAL_KEY = 'credential.https://github.com.helper'

/** Absolute path so the credential helper keeps working under git's own PATH. */
function resolveSolusCli(): string | null {
  try {
    return execFileSync('which', ['solus'], { encoding: 'utf8', env: hostCliEnv(), timeout: 2_000 }).trim() || null
  } catch {
    return null
  }
}

let serverEntry: { runtime: string; entry: string } | null = null

/** The standalone server names its own entry, so its helper needs nothing on PATH. */
export function useServerEntry(entry: { runtime: string; entry: string } | null): void {
  serverEntry = entry
}

/** `'it'\''s'`: one argument to the shell git runs a `!` helper with. */
function shellArgument(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * The Solus git helper as a git `credential.helper` value, with `flags` after
 * the command: the standalone server's own entry, else the installed `solus`
 * CLI. Null when this host has neither. The leading "!" makes git run it as a
 * shell command rather than look for a `git-credential-<name>` binary.
 */
export function solusGitHelper(flags: string[]): string | null {
  const command = serverEntry ? [serverEntry.runtime, serverEntry.entry] : [resolveSolusCli()]
  if (command.some((part) => !part)) return null
  return `!${[...command.map((part) => shellArgument(part!)), 'git-credential', ...flags.map(shellArgument)].join(' ')}`
}

/** Where a member's GitHub connection is written in their home, for `--member-home` to read. */
export const MEMBER_GITHUB_FILE = ['.config', 'solus', 'github.json'] as const

const memberGithubSchema = z.object({ token: z.string().min(1), login: z.string() })

/** The member's token from `$HOME`, which Solus set to their home; null when they have none. */
function memberHomeToken(): string | null {
  try {
    return memberGithubSchema.parse(JSON.parse(readFileSync(join(homedir(), ...MEMBER_GITHUB_FILE), 'utf8'))).token
  } catch {
    return null
  }
}

/** Which credential one helper invocation serves. */
export type GitCredentialSource =
  | { kind: 'host' }
  | { kind: 'delegation'; deviceId: string }
  | { kind: 'member-home' }

/** Only github.com is served: the stored token is a GitHub OAuth user token. */
const SUPPORTED_HOST = 'github.com'
/** Git's own convention for "this password is a token, not a user password". */
const TOKEN_USERNAME = 'x-access-token'

export type GitCredentialAction = 'get' | 'store' | 'erase'

export function coerceGitCredentialAction(value: string | undefined): GitCredentialAction {
  if (value === 'get' || value === 'store' || value === 'erase') return value
  throw new Error('Unknown git-credential action. Expected: get, store or erase.')
}

export interface GitCredentialRequest {
  protocol?: string
  host?: string
}

function parseCredentialRequest(input: string): GitCredentialRequest {
  const fields: GitCredentialRequest = {}
  for (const line of input.split('\n')) {
    if (!line.trim()) continue
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    if (key === 'protocol') fields.protocol = value
    if (key === 'host') fields.host = value
  }
  return fields
}

/**
 * The credential git should use, or null when this host has nothing to offer for
 * the request — an unknown host, a non-HTTPS protocol, or no stored token.
 */
export function credentialFor(
  fields: GitCredentialRequest,
  token: string | null,
): { username: string; password: string } | null {
  if (!token) return null
  if (fields.protocol && fields.protocol !== 'https') return null
  if (fields.host && fields.host !== SUPPORTED_HOST) return null
  return { username: TOKEN_USERNAME, password: token }
}

export async function runGitCredentialHelper(
  action: GitCredentialAction,
  stdin: NodeJS.ReadableStream,
  stdout: NodeJS.WritableStream,
  source: GitCredentialSource,
): Promise<void> {
  // `store` and `erase` are no-ops: the token's lifecycle belongs to Solus's
  // keyring, and git must not be able to delete it.
  if (action !== 'get') return

  const fields = parseCredentialRequest(await text(stdin))
  // A separate process with no principal: the source names whose credential it serves.
  const token = source.kind === 'delegation' ? delegatedGithubToken(source.deviceId)
    : source.kind === 'member-home' ? memberHomeToken()
    : readHostCredential('github', githubStoredTokenSchema)?.accessToken ?? null
  const credential = credentialFor(fields, token)
  if (credential) stdout.write(`username=${credential.username}\npassword=${credential.password}\n`)
}

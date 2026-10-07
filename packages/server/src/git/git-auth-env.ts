import { currentIdentity } from '../vault/acting-scope'
import { sshConnectionOptions } from '../transport/handlers/lib/ssh-options'

/**
 * How one git command reaches a remote when the caller chose the credential for
 * it: a clone, a publish, a managed review checkout. Only the host needs this. A
 * member's own home already answers with their connection, and nothing a caller
 * passes may change that (plans/019-acting-identity.md).
 *
 * The token travels in the environment and a helper for this one command reads
 * it, so it never reaches argv, the remote URL, or `.git/config`.
 */
export interface GitCommandAuth {
  /** `-c` options that go before the git subcommand. */
  args: string[]
  env: NodeJS.ProcessEnv
}

const TOKEN_HELPER = `!f() { test "$1" = get && printf 'username=x-access-token\\npassword=%s\\n' "$SOLUS_GIT_TOKEN"; }; f`

export function gitCommandAuth(options: { isHttps: boolean; token: string | null }): GitCommandAuth {
  if (!currentIdentity('a git command').isHost) return { args: [], env: {} }
  if (!options.isHttps) return { args: [], env: { GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: `ssh ${sshConnectionOptions().join(' ')}` } }
  if (!options.token) return { args: [], env: { GIT_TERMINAL_PROMPT: '0' } }
  return {
    // The empty value clears every helper the host or the checkout configured, so the chosen token answers alone.
    args: ['-c', 'credential.helper=', '-c', `credential.helper=${TOKEN_HELPER}`],
    env: { GIT_TERMINAL_PROMPT: '0', SOLUS_GIT_TOKEN: options.token },
  }
}

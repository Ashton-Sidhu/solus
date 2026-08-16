import { execFile } from 'child_process'
import { isRemoteDispatchCheckoutPath } from '../../../shared/types'
import { getCliEnv } from '../../cli-env'
import { loadDelegation } from './delegation-store'
import { loadToken } from './token-store'

/**
 * The one place that decides which GitHub credential an operation acts with.
 * `token-store` and `delegation-store` are this module's implementation — read
 * them from here, not directly, so the policy cannot fork again.
 */

/** The account this host is connected as. */
export function hostGithubToken(): string | null {
  try {
    return loadToken()?.accessToken ?? null
  } catch {
    return null
  }
}

/** A paired device's delegated credential, as served by `solus git-credential`. */
export function delegatedGithubToken(deviceId: string): string | null {
  try {
    return loadDelegation(deviceId)?.accessToken ?? null
  } catch {
    return null
  }
}

/**
 * The credential a checkout operates under. Asks git rather than re-deriving
 * it, so the answer is by construction the same one the checkout's own
 * credential helper hands a `git push` — a dispatch checkout has a delegated
 * helper written into its local config, and linked worktrees inherit it.
 */
export async function githubTokenForCheckout(cwd: string): Promise<string | null> {
  const configured = await askGitForToken(cwd)
  if (configured) return configured
  // No helper answered. Falling back to the host's own credential is right for
  // an ordinary project but is exactly the substitution to avoid on a dispatch
  // checkout, whose work belongs to the device that dispatched it.
  return isRemoteDispatchCheckoutPath(cwd) ? null : hostGithubToken()
}

/** `git credential fill` speaks the same key=value protocol on stdin and stdout. */
function askGitForToken(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      ['-C', cwd, 'credential', 'fill'],
      { encoding: 'utf-8', timeout: 10_000, env: getCliEnv({ GIT_TERMINAL_PROMPT: '0' }) },
      (error, stdout) => {
        if (error) return resolve(null)
        const password = stdout.split('\n').find((line) => line.startsWith('password='))
        resolve(password ? password.slice('password='.length) || null : null)
      },
    )
    child.stdin?.end('protocol=https\nhost=github.com\n\n')
  })
}

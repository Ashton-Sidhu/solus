import { dispatchCheckoutDeviceId } from '../../project-config/dispatch-checkouts'
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
 * The credential a checkout operates under — the same one its git credential
 * helper hands a `git push`, since a dispatch checkout is cloned for exactly
 * one paired device and configured to push as it.
 *
 * Falling back to the host is not a loophole: `configureDelegatedCheckout`
 * stores the delegation and sets the checkout's `user.name`/`user.email` in one
 * step, so no delegation means no client identity was ever written and the
 * commits are the host's. A web client dispatches this way by design — a
 * browser has no credential store to delegate from — and its checkout still
 * lands under `solus-remote/<deviceId>/` because the path is keyed on the
 * device, not on whether a credential came with it.
 */
export function githubTokenForCheckout(cwd: string): string | null {
  const deviceId = dispatchCheckoutDeviceId(cwd)
  return (deviceId ? delegatedGithubToken(deviceId) : null) ?? hostGithubToken()
}

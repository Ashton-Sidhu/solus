import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { join } from 'path'

const root = join(import.meta.dir, '../..')

/**
 * The rule under test: the checkout decides which GitHub account acts on it,
 * and a dispatch checkout names its owning device in its own path — the same
 * path `dispatchCheckoutPath` built when the clone was created for that device.
 * Getting this wrong does not fail loudly; it files one device's work under
 * another account.
 *
 * Run in a child process: `mock.module` is process-wide in Bun, so stubbing the
 * token stores here would leak into every other suite in the same run.
 */
function resolveTokens(): {
  dispatch: string | null
  dispatchWorktree: string | null
  unpaired: string | null
  hostProject: string | null
} {
  const script = String.raw`
    import { mock } from 'bun:test'
    mock.module('./src/main/providers/github/token-store', () => ({
      loadToken: () => ({ accessToken: 'host-token', scope: 'repo', login: 'host-login' }),
      persistToken: () => {},
      clearToken: () => {},
      EncryptionUnavailableError: class EncryptionUnavailableError extends Error {},
    }))
    mock.module('./src/main/providers/github/delegation-store', () => ({
      loadDelegation: (deviceId) => deviceId === 'phone-1'
        ? { accessToken: 'delegated-token', login: 'client-login' }
        : null,
    }))

    const { githubTokenForCheckout } = await import('./src/main/providers/github/credentials')
    const DISPATCH = '/Users/host/projects/solus-remote/phone-1/github.com/acme/widgets'

    console.log(JSON.stringify({
      dispatch: githubTokenForCheckout(DISPATCH),
      dispatchWorktree: githubTokenForCheckout(DISPATCH + '/.solus-worktrees/acme__fix'),
      unpaired: githubTokenForCheckout('/Users/host/projects/solus-remote/gone/github.com/acme/widgets'),
      hostProject: githubTokenForCheckout('/Users/host/projects/solus'),
    }))
  `
  const run = spawnSync(process.execPath, ['-e', script], { cwd: root, encoding: 'utf8' })
  expect(run.stderr).toBe('')
  expect(run.status).toBe(0)
  return JSON.parse(run.stdout)
}

describe('GitHub credential for a checkout', () => {
  const resolved = resolveTokens()

  test('a dispatch checkout acts as the device it was cloned for', () => {
    expect(resolved.dispatch).toBe('delegated-token')
  })

  test('a worktree inside a dispatch checkout belongs to the same device', () => {
    // Linked worktrees share the checkout's git config, so the token must match
    // what a push from them would use.
    expect(resolved.dispatchWorktree).toBe('delegated-token')
  })

  test('a dispatch checkout never falls back to the host account', () => {
    // The dangerous failure: publishing or opening a PR as the host owner using
    // a checkout whose commits are authored by someone else.
    expect(resolved.unpaired).toBeNull()
  })

  test('an ordinary project acts as the host, whichever client asked', () => {
    // A remote web client working on the host's own project is *not* dispatched
    // — the old caller-keyed rule got exactly this case wrong.
    expect(resolved.hostProject).toBe('host-token')
  })
})

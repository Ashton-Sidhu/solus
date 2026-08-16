import { describe, expect, test } from 'bun:test'
import { execFileSync, spawnSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const root = join(import.meta.dir, '../..')

/**
 * The rule under test: git decides which GitHub account acts on a checkout.
 * `setupPrepareProject` writes a delegated credential helper into a dispatch
 * checkout's local config, so asking git is what keeps the account that opens a
 * pull request or creates a repository identical to the one whose credential
 * pushed the commits. Getting this wrong does not fail loudly — it files one
 * device's work under another account.
 */

/** A checkout whose local config answers with `token`, like a dispatch clone. */
function checkoutWithHelper(token: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'solus-cred-'))
  execFileSync('git', ['init', '-q', dir])
  if (token) {
    const helper = join(dir, 'helper.sh')
    writeFileSync(helper, `#!/bin/sh\n[ "$1" = "get" ] && printf 'username=x-access-token\\npassword=${token}\\n'\n`)
    chmodSync(helper, 0o700)
    execFileSync('git', ['-C', dir, 'config', '--local', 'credential.https://github.com.helper', `!${helper}`])
  } else {
    // An empty helper list stops git consulting the developer's real global
    // helper, so the test cannot depend on the machine it runs on.
    execFileSync('git', ['-C', dir, 'config', '--local', 'credential.https://github.com.helper', ''])
  }
  return dir
}

function resolveTokens(delegatedCheckout: string, plainCheckout: string, dispatchCheckout: string) {
  const script = String.raw`
    import { mock } from 'bun:test'
    mock.module('./src/main/providers/github/token-store', () => ({
      loadToken: () => ({ accessToken: 'host-token', scope: 'repo', login: 'host-login' }),
      persistToken: () => {},
      clearToken: () => {},
      EncryptionUnavailableError: class EncryptionUnavailableError extends Error {},
    }))
    const { githubTokenForCheckout, hostGithubToken } =
      await import('./src/main/providers/github/credentials')
    console.log(JSON.stringify({
      delegated: await githubTokenForCheckout(${JSON.stringify(delegatedCheckout)}),
      plain: await githubTokenForCheckout(${JSON.stringify(plainCheckout)}),
      dispatchWithoutHelper: await githubTokenForCheckout(${JSON.stringify(dispatchCheckout)}),
      host: hostGithubToken(),
    }))
  `
  const run = spawnSync(process.execPath, ['-e', script], { cwd: root, encoding: 'utf8' })
  expect(run.status).toBe(0)
  const lines = run.stdout.trim().split('\n')
  return JSON.parse(lines[lines.length - 1]) as {
    delegated: string | null
    plain: string | null
    dispatchWithoutHelper: string | null
    host: string | null
  }
}

describe('GitHub credential for a checkout', () => {
  const delegatedCheckout = checkoutWithHelper('delegated-token')
  const plainCheckout = checkoutWithHelper(null)
  // A dispatch checkout is identified by its path; this one has no helper
  // configured, standing in for a device whose delegation was never stored.
  const dispatchCheckout = join(plainCheckout, 'solus-remote', 'phone-1', 'github.com', 'acme', 'widgets')
  const resolved = resolveTokens(delegatedCheckout, plainCheckout, dispatchCheckout)

  try {
    test('takes whatever the checkout’s own credential helper answers', () => {
      expect(resolved.delegated).toBe('delegated-token')
    })

    test('falls back to the host account when no helper answers', () => {
      // Publish is a first-run flow, so it has to keep working on a host that
      // connected GitHub in Solus but never installed the global git helper.
      expect(resolved.plain).toBe('host-token')
    })

    test('never falls back to the host account on a dispatch checkout', () => {
      // The fallback above is exactly the substitution to avoid here: this
      // checkout's work belongs to the device that dispatched it.
      expect(resolved.dispatchWithoutHelper).toBeNull()
    })
  } finally {
    rmSync(delegatedCheckout, { recursive: true, force: true })
    rmSync(plainCheckout, { recursive: true, force: true })
  }
})

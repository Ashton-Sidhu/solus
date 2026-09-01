import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PassThrough } from 'stream'
import {
  credentialFor,
  loadGitHubAccessToken,
  runGitCredentialHelper,
  type GitCredentialAction,
} from '../../src/main/providers/github/git-credential'
import { saveDelegation } from '../../src/main/providers/github/delegation-store'
import { persistToken } from '../../src/main/providers/github/token-store'

const originalDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-git-credential-test-'))
  process.env.SOLUS_DATA_DIR = dataDir
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
  if (originalDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = originalDataDir
})

describe('git credential helper', () => {
  test('offers a GitHub token using git token-as-password convention', () => {
    // WHY: git only accepts a PAT for HTTPS authentication when it is supplied
    // as the password paired with the conventional token username.
    expect(credentialFor(
      { protocol: 'https', host: 'github.com' },
      'github-token',
    )).toEqual({ username: 'x-access-token', password: 'github-token' })
  })

  test('does not offer a token to a non-HTTPS transport', () => {
    // WHY: a delegated token must never be handed to a transport that can leak
    // it, and SSH must authenticate with its own key instead.
    expect(credentialFor(
      { protocol: 'ssh', host: 'github.com' },
      'github-token',
    )).toBeNull()
  })

  test('does not offer a GitHub token to another host', () => {
    // WHY: the stored credential is a GitHub OAuth user token, so offering it
    // to any other host would disclose the user's credential.
    expect(credentialFor(
      { protocol: 'https', host: 'example.com' },
      'github-token',
    )).toBeNull()
  })

  test('falls through when Solus has no token', () => {
    // WHY: writing no credential lets git try its next configured helper rather
    // than turning a missing Solus credential into an authentication failure.
    expect(credentialFor(
      { protocol: 'https', host: 'github.com' },
      null,
    )).toBeNull()
  })

  test('ignores git requests to store or erase the Solus-owned token', async () => {
    // WHY: the credential lifecycle belongs to Solus's keyring, and git must
    // not be able to overwrite or delete that durable credential.
    for (const action of ['store', 'erase'] satisfies GitCredentialAction[]) {
      const stdin = new PassThrough()
      const stdout = new PassThrough()
      stdin.end('protocol=https\nhost=github.com\n\n')

      await runGitCredentialHelper(action, stdin, stdout)

      expect(stdout.read()).toBeNull()
    }
  })

  test('uses the dispatching device token instead of the host token under delegation', async () => {
    // WHY: remote git operations must run as the person who dispatched the
    // session, not silently use the remote host owner's GitHub identity.
    persistToken({ accessToken: 'host-token', scope: 'repo', login: 'host-owner' })
    saveDelegation('dev_caller', { accessToken: 'delegated-token', login: 'caller' })
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    stdin.end('protocol=https\nhost=github.com\n\n')

    await runGitCredentialHelper('get', stdin, stdout, 'dev_caller')

    expect(stdout.read()?.toString()).toBe(
      'username=x-access-token\npassword=delegated-token\n',
    )
    expect(loadGitHubAccessToken('dev_caller')).toBe('delegated-token')
    expect(loadGitHubAccessToken()).toBe('host-token')
  })
})

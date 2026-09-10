import { afterEach, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GitExecOptions } from '@solus/server/git/exec'

const repo = { host: 'github.com', owner: 'test', repo: 'private' }
const target = { kind: 'pr' as const, ...repo, number: 1, baseSha: 'base', headSha: 'head' }
const attempts: string[] = []
const helpers: string[] = []
let failureStage = 'clone'
let failureMessage = 'fatal: Authentication failed'
let rejectAll = false
let checkoutPath = ''
let root = ''

mock.module('@solus/server/providers/github/credentials', () => ({
  githubCredentialChain: async () => [
    { source: 'host', token: 'test-host-token' },
    { source: 'gh-cli', token: 'test-gh-token' },
  ],
}))
mock.module('@solus/server/git/exec', () => ({
  runAsync: async (_bin: string, args: string[], cwd: string, options?: GitExecOptions) => {
    const command = args[0] === '-c' ? args[2] : args[0]
    if (command === 'rev-parse') {
      if (args.includes('HEAD')) return target.headSha
      if (args.includes('refs/solus/review/base')) return target.baseSha
      return 'true'
    }
    if (command !== 'clone' && command !== 'fetch') return ''
    const token = options?.env?.SOLUS_GIT_PASSWORD ?? ''
    const helper = options?.env?.GIT_ASKPASS ?? ''
    expect(existsSync(helper)).toBe(true)
    expect(args.slice(0, 2)).toEqual(['-c', 'credential.helper='])
    expect(args.join(' ')).not.toContain(token)
    helpers.push(helper)
    attempts.push(`${command}:${token}`)
    if (command === 'clone') {
      checkoutPath = args.at(-1)!
      // A failed clone/fetch must not leave a destination that blocks the retry.
      expect(existsSync(checkoutPath)).toBe(false)
      mkdirSync(join(checkoutPath, '.git'), { recursive: true })
      writeFileSync(join(checkoutPath, 'partial'), 'partial checkout')
    } else {
      expect(cwd).toBe(checkoutPath)
    }
    if (command === failureStage && (rejectAll || token === 'test-host-token')) {
      throw new Error(failureMessage)
    }
    return ''
  },
}))

const { ensureManagedPrCheckout } = await import('@solus/server/review/managed-pr-checkout')

afterEach(() => {
  for (const helper of helpers) expect(existsSync(helper)).toBe(false)
  if (root) rmSync(root, { recursive: true, force: true })
  attempts.length = 0
  helpers.length = 0
  rejectAll = false
})

for (const stage of ['clone', 'fetch']) {
  for (const message of [
    'fatal: Authentication failed',
    'remote: Repository not found.',
    'fatal: unable to access URL: The requested URL returned error: 403',
  ]) {
    test(`uses gh after ${stage} fails with ${message}`, async () => {
      root = mkdtempSync(join(tmpdir(), 'solus-review-auth-'))
      failureStage = stage
      failureMessage = message
      const result = await ensureManagedPrCheckout(repo, target, { root })
      expect(result.headSha).toBe(target.headSha)
      expect(result.baseSha).toBe(target.baseSha)
      expect(attempts).toContain(`${stage}:test-host-token`)
      expect(attempts.slice(-3)).toEqual([
        'clone:test-gh-token', 'fetch:test-gh-token', 'fetch:test-gh-token',
      ])
    })
  }
}

test('does not retry a network failure with another account', async () => {
  root = mkdtempSync(join(tmpdir(), 'solus-review-auth-'))
  failureStage = 'clone'
  failureMessage = 'fatal: Could not resolve host: github.com'
  await expect(ensureManagedPrCheckout(repo, target, { root })).rejects.toThrow(failureMessage)
  expect(attempts).toEqual(['clone:test-host-token'])
  expect(existsSync(checkoutPath)).toBe(false)
})

test('stops and cleans up when both credentials are rejected', async () => {
  root = mkdtempSync(join(tmpdir(), 'solus-review-auth-'))
  failureStage = 'clone'
  failureMessage = 'fatal: Authentication failed'
  rejectAll = true
  await expect(ensureManagedPrCheckout(repo, target, { root })).rejects.toThrow(failureMessage)
  expect(attempts).toEqual(['clone:test-host-token', 'clone:test-gh-token'])
  expect(existsSync(checkoutPath)).toBe(false)
})

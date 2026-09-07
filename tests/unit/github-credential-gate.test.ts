import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { Provider, RepoRef } from '@solus/server/providers/types'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

/**
 * Which credential may act is decided by the chain, never by this host's own
 * connection (ADR-0018). Publishing browser evidence to a pull request used to
 * ask `auth.status()` first, which reads only the token Solus's device flow
 * stored — so a user signed in through `gh`, and a dispatched checkout carrying
 * its owner's delegated token, were both told to "connect GitHub" while a
 * working credential sat one layer down. These tests pin that the gate asks the
 * question the chain answers.
 */

let attachEvidence: typeof import('@solus/server/browser/browser-evidence')['attachEvidence']

let hasCredentialAnswer = false
const asked: Array<{ host: string; cwd?: string }> = []
let publishedAssets = 0

const stubProvider = {
  id: 'github',
  auth: {
    // What Settings reports: this host completed no device flow. Deliberately
    // the opposite of the chain's answer, so a call site that consults it
    // instead of hasCredential fails these tests.
    status: async () => ({ connected: false }),
    hasCredential: async (host: string, cwd?: string) => {
      asked.push({ host, cwd })
      return hasCredentialAnswer
    },
  },
  review: {
    publishAsset: async () => {
      publishedAssets++
      return 'https://github.com/acme/app/assets/1'
    },
    addIssueComment: async () => undefined,
  },
} as unknown as Provider

const page = {
  url: 'http://localhost:5173/tasks',
  title: 'Tasks',
  viewport: { width: 1280, height: 800 },
} as never

beforeAll(async () => {
  mock.module('@solus/server/git/git-helpers', () => ({
    resolveRepoRef: async (): Promise<RepoRef> => ({ host: 'github.com', owner: 'acme', repo: 'app' }),
  }))
  mock.module('@solus/server/providers/registry', () => ({
    providerForRepo: (repo: RepoRef) => (repo.host === 'github.com' ? stubProvider : null),
  }))
  ;({ attachEvidence } = await import('@solus/server/browser/browser-evidence'))
})

describe('publishing evidence gates on the credential chain, not the host connection', () => {
  test('a credential this host never stored still reaches the provider', async () => {
    hasCredentialAnswer = true
    publishedAssets = 0
    asked.length = 0

    const attached = await attachEvidence('asset-1', { kind: 'pr', number: 42, cwd: '/work/checkout' }, { page })

    expect(attached.attachedTo).toContain('42')
    expect(publishedAssets).toBe(1)
    // The checkout is part of the question: a dispatched worktree's delegated
    // token is the first credential in the chain, and only the cwd finds it.
    expect(asked).toEqual([{ host: 'github.com', cwd: '/work/checkout' }])
  })

  test('no credential at all still names the way to fix it', async () => {
    hasCredentialAnswer = false
    publishedAssets = 0

    await expect(
      attachEvidence('asset-1', { kind: 'pr', number: 42, cwd: '/work/checkout' }, { page }),
    ).rejects.toThrow('Settings → Connections')
    expect(publishedAssets).toBe(0)
  })
})

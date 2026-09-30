import { afterAll, describe, expect, test } from 'bun:test'
import type { PrReviewer, PrReviewerCandidate, ReviewThread } from '@solus/contracts/providers'
import { serializeReferenceToken, type ReferenceToken } from '@solus/workspace-ui/components/editor/reference-tokens'
import {
  codeHostMentionCandidates,
  codeHostMentionQuery,
  codeHostMentionRows,
} from '@solus/workspace-ui/components/mentions/lib/code-host-mentions'
import { prMentionAccounts, warmPrMentions, type PrMentionStore } from '@solus/workspace-ui/components/pr-review/lib/pr-mentions'
import { SvelteRunes } from './helpers/svelte-runes'

// `@` on a pull request behaves as on GitHub: it offers the people in the pull
// request first, then collaborators, and writes plain `@login` so GitHub
// notifies them. The people come from the pull request store, read once.

describe('the @login query', () => {
  test('opens after the line start, whitespace or a parenthesis', () => {
    expect(codeHostMentionQuery('@')).toBe('')
    expect(codeHostMentionQuery('thanks @oc')).toBe('oc')
    expect(codeHostMentionQuery('(@oc')).toBe('oc')
  })

  test('stays shut inside an email and ends at a space, as a login has none', () => {
    expect(codeHostMentionQuery('me@acme')).toBeNull()
    expect(codeHostMentionQuery('@octo ')).toBeNull()
  })
})

describe('the accounts a pull request offers', () => {
  const thread = (authors: [string, string][]): ReviewThread => ({
    comments: authors.map(([author, createdAt], index) => ({ id: `${author}-${index}`, author, body: '', createdAt })),
  }) as ReviewThread
  const reviewers: PrReviewer[] = [{ login: 'rev', avatarUrl: 'r.png' } as PrReviewer]
  const candidates: PrReviewerCandidate[] = [
    { kind: 'user', login: 'zed' },
    { kind: 'user', login: 'Author' },
    { kind: 'team', slug: 'ops', name: 'Ops' },
  ]

  test('people in the pull request lead, newest thread author first, then collaborators', () => {
    const accounts = prMentionAccounts({
      author: 'author',
      reviewers,
      threads: [thread([['old', '2026-01-01'], ['new', '2026-02-01']])],
      candidates,
    })
    expect(accounts.map((account) => account.login)).toEqual(['author', 'rev', 'new', 'old', 'zed'])
  })

  test('drops bots, which GitHub does not mention by that login', () => {
    const accounts = prMentionAccounts({ author: 'github-actions[bot]', reviewers: [], threads: [], candidates: [] })
    expect(accounts).toEqual([])
  })

  test('a prefix match ranks above a match inside the login', () => {
    const accounts = [{ login: 'mocha' }, { login: 'octo' }]
    expect(codeHostMentionCandidates(accounts, 'oc').map((account) => account.login)).toEqual(['octo', 'mocha'])
  })

  test('no match shows no menu, so the typed @login stays text', () => {
    expect(codeHostMentionRows([], 'nobody')).toEqual([])
  })

  test('a login writes as @login, the text GitHub reads as a mention', () => {
    expect(serializeReferenceToken({ kind: 'login', login: 'octo' })).toBe('@octo')
  })
})

describe('loading the people', () => {
  function store(overrides: Partial<PrMentionStore> = {}) {
    const calls = { reviewers: 0, candidates: 0 }
    const pullRequest: PrMentionStore = {
      capabilities: { reviewerCandidates: true },
      loadReviewers: async () => { calls.reviewers += 1; return [] },
      loadReviewerCandidates: async () => { calls.candidates += 1; return [] },
      ...overrides,
    }
    return { pullRequest, calls }
  }

  test('does not ask again for what the store already holds', () => {
    const { pullRequest, calls } = store({ reviewers: [], reviewerCandidates: [] })
    warmPrMentions(pullRequest)
    expect(calls).toEqual({ reviewers: 0, candidates: 0 })
  })

  test('reads what no surface has read yet, and no candidates the host cannot list', () => {
    const { pullRequest, calls } = store({ capabilities: { reviewerCandidates: false } })
    warmPrMentions(pullRequest)
    expect(calls).toEqual({ reviewers: 1, candidates: 0 })
  })
})

describe('the picker on a pull request', () => {
  const runes = new SvelteRunes()
  afterAll(() => runes.dispose())
  const pickerModule = runes.source('mention-picker', 'packages/workspace-ui/src/components/mentions/lib/mention-picker.svelte.ts', {
    '../../editor/unified-autocomplete/rows': SvelteRunes.file('packages/workspace-ui/src/components/editor/unified-autocomplete/rows.ts'),
    './mentions': SvelteRunes.file('packages/workspace-ui/src/components/mentions/lib/mentions.ts'),
    './mention-rows': SvelteRunes.file('packages/workspace-ui/src/components/mentions/lib/mention-rows.ts'),
  })

  test('Enter writes the chosen login over the @query', async () => {
    const { MentionPicker } = await import(pickerModule)
    const { codeHostMentionSource } = await import('@solus/workspace-ui/components/mentions/lib/code-host-mentions')
    const inserted: { token: ReferenceToken; pattern: RegExp }[] = []
    let warmed = 0
    const instance = new MentionPicker({
      source: codeHostMentionSource({ accounts: () => [{ login: 'octo' }, { login: 'mona' }], warm: () => { warmed += 1 } }),
      editor: () => ({
        textBeforeCursor: () => '',
        cursorRect: () => null,
        insertReference: (token: ReferenceToken, pattern: RegExp) => { inserted.push({ token, pattern }); return true },
        focus: () => {},
      }),
    })
    instance.handleEditorChange('cc @mo')
    instance.handleEditorChange('cc @mon')
    expect(warmed).toBe(1)
    // SAFETY: the picker reads only the key, the modifiers and the two verbs.
    const event = { key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, preventDefault() {}, stopPropagation() {} } as unknown as KeyboardEvent
    expect(instance.handleKeyDown(event)).toBe(true)
    expect(inserted.map((entry) => entry.token)).toEqual([{ kind: 'login', login: 'mona' }])
    expect('cc @mon'.replace(inserted[0]!.pattern, '@mona ')).toBe('cc @mona ')
  })
})

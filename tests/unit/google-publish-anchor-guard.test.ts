import { expect, mock, test } from 'bun:test'
import type { DocsRequest } from '@solus/server/google/docs-api'
mock.module('@solus/server/google/docs-comment-checkpoint', () => ({ commentCheckpoint: async (_documentId: string, _tabId: string, _text: string, comments: { quote: string }[]) => ({ quotes: comments.map(comment => comment.quote), save: async () => {} }) }))
const drive = await import('@solus/server/google/drive')
let creationWrites = 0, updateWrites = 0, revision: string | undefined
let tokenReads = 0
let tokenGate: Promise<void> | undefined
let tokenRead: (() => void) | undefined
mock.module('@solus/server/google/oauth', () => ({ getAccessToken: async () => { tokenReads++; tokenRead?.(); await tokenGate; return 'token' }, isGoogleOAuthConfigured: () => true, grantedGoogleScopes: () => [] }))
mock.module('@solus/server/google/drive', () => ({
  ...drive,
  fileMetadata: async () => ({ id: 'doc', name: 'Test', version: '1' }),
  renameFile: async () => ({ id: 'doc', name: 'Test', version: '1' }),
  docUrlFor: () => 'https://docs.google.com/document/d/doc/edit',
}))
mock.module('@solus/server/google/docs-publish', () => ({ writeNewDocsBody: async () => { creationWrites++ } }))
const api = await import('@solus/server/google/docs-api')
mock.module('@solus/server/google/docs-api', () => ({
  ...api,
  getEditableDocument: async () => ({ revisionId: 'revision-1', tabs: [{ tabProperties: { tabId: 'tab-1' }, documentTab: { body: { content: [
    { startIndex: 1, endIndex: 12, paragraph: { elements: [{ startIndex: 1, endIndex: 12, textRun: { content: 'Keep this.\n' } }] } },
  ] } } }] }),
  batchUpdateDocument: async (_token: string, _id: string, _requests: DocsRequest[], requiredRevisionId?: string) => { updateWrites++; revision = requiredRevisionId },
}))
const googleComments = await import('@solus/server/google/comments')
mock.module('@solus/server/google/comments', () => ({
  ...googleComments,
  listGoogleComments: async () => [{ anchor: 'kix.native', quote: 'Keep', deleted: false }],
}))
const { GoogleDriveDocAdapter } = await import('@solus/server/docs/gdrive/adapter')
const ref = { provider: 'gdrive' as const, externalId: 'doc', externalKey: 'root', url: 'https://docs.google.com/document/d/doc/edit' }

test('legacy highlight-loss opt-in cannot authorize replacement or edits to commented text', async () => {
  const adapter = new GoogleDriveDocAdapter()
  const legacyPatch = { markdown: 'Remove this.', allowCommentAnchorLoss: true }
  await expect(adapter.update(ref, legacyPatch)).rejects.toThrow('commented text')
  expect(creationWrites).toBe(0)
  expect(updateWrites).toBe(0)
})

test('supported changes use targeted writes with a required revision', async () => {
  await new GoogleDriveDocAdapter().update(ref, { markdown: 'Keep that.', expectedVersion: '1' })
  expect(creationWrites).toBe(0)
  expect(updateWrites).toBe(1)
  expect(revision).toBe('revision-1')
})

test('updates from separate adapters serialize the document checkpoint', async () => {
  let release!: () => void, entered!: () => void
  tokenGate = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  tokenRead = entered
  const initialReads = tokenReads
  const first = new GoogleDriveDocAdapter().update(ref, { markdown: 'Keep that.' })
  await started
  const second = new GoogleDriveDocAdapter().update(ref, { markdown: 'Keep that.' })
  await Promise.resolve()
  try { expect(tokenReads).toBe(initialReads + 1) }
  finally { release(); tokenGate = undefined; tokenRead = undefined }
  await Promise.all([first, second])
  expect(tokenReads).toBe(initialReads + 2)
})

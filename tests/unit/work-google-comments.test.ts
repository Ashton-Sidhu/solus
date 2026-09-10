import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
mock.module('@solus/server/google/oauth', () => ({ getAccessToken: async () => 'test-token', grantedGoogleScopes: () => [], isGoogleOAuthConfigured: () => true }))
const externalComments = await import('@solus/server/google/comments')
let postCount = 0
let rejectPost = false
let rejectList = false
const sentBodies: string[] = []
let onList: (() => Promise<void>) | undefined
mock.module('@solus/server/google/comments', () => ({
  ...externalComments,
  listGoogleComments: async () => { await onList?.(); if (rejectList) throw new Error('refresh failed'); return [] },
  postGoogleComment: async (_token: string, _doc: string, body: string) => { postCount++; sentBodies.push(body); if (rejectPost) throw new Error('connection lost') },
  postGoogleReply: async () => { postCount++ },
}))
let dataDir: string
let works: typeof import('@solus/server/folio/works')
let annotations: typeof import('@solus/server/folio/work-annotations')
let service: typeof import('@solus/server/folio/work-comments')
let closeDb: () => void
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-google-comments-unit-'))
  process.env.SOLUS_DATA_DIR = dataDir
  works = await import('@solus/server/folio/works')
  annotations = await import('@solus/server/folio/work-annotations')
  service = await import('@solus/server/folio/work-comments')
  ;({ closeDb } = await import('@solus/server/db'))
})
afterAll(() => { closeDb(); rmSync(dataDir, { recursive: true, force: true }) })
async function work() {
  const work = await works.createWork('Test', 'doc', 'hello', '', undefined, 'codex', dataDir)
  await works.setWorkMirroredDoc(work.id, { provider: 'gdrive', externalId: 'test-doc', externalKey: 'root', scope: 'root', url: 'https://docs.google.com/document/d/test-doc/edit', syncState: 'ok' })
  return work.id
}

test('refresh preserves private edits made during Google request; private saves cannot replace shared state', async () => {
  const workId = await work()
  onList = async () => { await annotations.saveWorkAnnotations({ version: 1, workId, updatedAt: 0, comments: [{ id: 'private', selectedText: 'hello', comment: 'For agent only' }] }) }
  await service.refreshWorkGoogleComments(workId)
  onList = undefined
  const saved = await annotations.loadWorkAnnotations(workId)
  expect(saved?.comments[0].comment).toBe('For agent only')
  expect(saved?.externalComments?.documentId).toBe('test-doc')
  await annotations.saveWorkAnnotations({ ...saved!, externalComments: { provider: 'gdrive', externalKey: 'root', documentId: 'fake', threads: [], operations: [] } })
  expect((await annotations.loadWorkAnnotations(workId))?.externalComments?.documentId).toBe('test-doc')
  expect(postCount).toBe(0)
})

test('duplicate request never reposts, including uncertain outcomes and concurrent submissions', async () => {
  const workId = await work()
  const command = { kind: 'share' as const, requestId: randomUUID(), text: 'Only this message' }
  const before = postCount
  rejectPost = true
  const [first, second] = await Promise.all([service.sendWorkGoogleComment(workId, command), service.sendWorkGoogleComment(workId, command)])
  rejectPost = false
  expect(postCount - before).toBe(1)
  expect(first.operations[0].status).toBe('uncertain')
  expect(second.operations[0].status).toBe('uncertain')
  expect((await service.readWorkGoogleComments(workId)).operations[0].command).toEqual(command)
})

test('unlink during refresh prevents stale snapshot from being installed', async () => {
  const workId = await work()
  onList = async () => { await works.setWorkMirroredDoc(workId, null) }
  await expect(service.refreshWorkGoogleComments(workId)).rejects.toThrow('link changed')
  onList = undefined
  expect((await annotations.loadWorkAnnotations(workId))?.externalComments).toBeUndefined()
})


test('only the explicit draft is posted; private history stays local', async () => {
  const workId = await work()
  await annotations.saveWorkAnnotations({ version: 1, workId, updatedAt: 0, comments: [{ id: 'private', selectedText: 'hello', comment: 'SECRET PRIVATE INSTRUCTION', replies: [{ id: 'reply', author: 'solus', text: 'PRIVATE AGENT ANALYSIS', createdAt: 1 }] }] })
  const command = { kind: 'share' as const, requestId: randomUUID(), text: 'Public response', quote: 'hello', sourceMessageId: 'private' }
  await service.sendWorkGoogleComment(workId, command)
  expect((await service.readWorkGoogleComments(workId)).operations[0].command).toEqual(command)
  expect(sentBodies.at(-1)).toBe('Public response')
  expect((await annotations.loadWorkAnnotations(workId))?.comments[0].replies?.[0].text).toBe('PRIVATE AGENT ANALYSIS')
  await expect(service.sendWorkGoogleComment(workId, { ...command, text: 'Changed draft' })).rejects.toThrow('another message')
})

test('a send acknowledged before failed read-back is never repeated', async () => {
  const workId = await work()
  const command = { kind: 'share' as const, requestId: randomUUID(), text: 'One post' }
  const before = postCount
  rejectList = true
  const result = await service.sendWorkGoogleComment(workId, command)
  rejectList = false
  expect(result.operations[0].status).toBe('sent')
  expect(result.error).toBe('refresh failed')
  await service.sendWorkGoogleComment(workId, command)
  expect(postCount - before).toBe(1)
})

test('a recorded in-flight operation survives restart without automatic resend', async () => {
  const workId = await work()
  const command = { kind: 'share' as const, requestId: randomUUID(), text: 'Possibly sent before crash' }
  annotations.saveExternalComments(workId, { provider: 'gdrive', externalKey: 'root', documentId: 'test-doc', threads: [], operations: [{ requestId: command.requestId, command, status: 'sending' }] })
  const before = postCount
  await service.sendWorkGoogleComment(workId, command)
  expect(postCount).toBe(before)
})

test('sync uses the registered provider capability and keeps delivery IDs at the host', async () => {
  const { docProviderAdapter } = await import('@solus/server/docs/registry')
  const comments = docProviderAdapter('gdrive').comments!
  const originalMutate = comments.mutate
  const mutations: import('@solus/contracts/doc-comments').DocCommentMutation[] = []
  comments.mutate = async (ref, mutation) => {
    expect(ref.externalId).toBe('test-doc')
    mutations.push(mutation)
    return { threadId: 'created-thread' }
  }
  try {
    const workId = await work()
    const result = await service.sendWorkGoogleComment(workId, { kind: 'share', requestId: randomUUID(), text: 'Selected message', quote: 'hello' })
    expect(mutations).toEqual([{ action: 'create', text: 'Selected message', quote: 'hello' }])
    expect(result.operations[0].result).toEqual({ threadId: 'created-thread' })
    expect((await annotations.loadWorkAnnotations(workId))?.externalComments?.operations[0].result).toEqual({ threadId: 'created-thread' })
    expect(result.capabilities?.actions).toContain('create')
    expect(result.operations[0].status).toBe('sent')
  } finally { comments.mutate = originalMutate }
})

test('Google document read-only policy permits publishing comments and replying', async () => {
  const { docProviderAdapter } = await import('@solus/server/docs/registry')
  const adapter = docProviderAdapter('gdrive').comments!
  const originalList = adapter.list
  const originalMutate = adapter.mutate
  const mutations: import('@solus/contracts/doc-comments').DocCommentMutation[] = []
  adapter.list = async () => [{ id: 'review', text: 'Please confirm', quote: 'hello', author: { name: 'Reviewer', isMe: false }, createdAt: '', modifiedAt: '', resolved: false, deleted: false, replies: [], allowedActions: ['reply'] }]
  adapter.mutate = async (_ref, mutation) => {
    mutations.push(mutation)
    return { threadId: mutation.action === 'create' ? 'shared' : 'review' }
  }
  try {
    const workId = await work()
    await expect(works.saveWork(workId, { content: 'Blocked body edit' })).rejects.toThrow(works.GOOGLE_WORK_READ_ONLY)
    const shared = await service.sendWorkExternalComment(workId, { kind: 'share', requestId: randomUUID(), text: 'Public comment', quote: 'hello' })
    expect(shared.operations.at(-1)?.status).toBe('sent')
    const replied = await service.sendWorkExternalComment(workId, { kind: 'reply', requestId: randomUUID(), threadId: 'review', text: 'Confirmed' })
    expect(replied.operations.at(-1)?.status).toBe('sent')
    expect(mutations).toEqual([{ action: 'create', text: 'Public comment', quote: 'hello' }, { action: 'reply', threadId: 'review', text: 'Confirmed' }])
    expect((await works.loadWork(workId))?.content).toBe('hello')
  } finally {
    adapter.list = originalList
    adapter.mutate = originalMutate
  }
})

test('definite provider rejection can retry the same receipt without duplicating success', async () => {
  const { docProviderAdapter } = await import('@solus/server/docs/registry')
  const { DocCommentRequestError } = await import('@solus/server/docs/types')
  const comments = docProviderAdapter('gdrive').comments!
  const originalMutate = comments.mutate
  let attempts = 0
  comments.mutate = async () => {
    if (++attempts === 1) throw new DocCommentRequestError('Permission denied', false)
    return {}
  }
  try {
    const workId = await work()
    const command = { kind: 'share' as const, requestId: randomUUID(), text: 'Retry after access restored' }
    expect((await service.sendWorkGoogleComment(workId, command)).operations[0].status).toBe('failed')
    expect((await service.sendWorkGoogleComment(workId, command)).operations[0].status).toBe('sent')
    await service.sendWorkGoogleComment(workId, command)
    expect(attempts).toBe(2)
  } finally { comments.mutate = originalMutate }
})

test('Confluence snapshots and sends use the linked site and preserve private comments', async () => {
  const { docProviderAdapter } = await import('@solus/server/docs/registry')
  const adapter = docProviderAdapter('confluence').comments!
  const originalList = adapter.list
  const originalMutate = adapter.mutate
  const thread = { id: 'footer:1', location: 'page' as const, text: 'External review', quote: '', author: { name: 'Reviewer', isMe: false }, createdAt: '', modifiedAt: '', resolved: false, deleted: false, replies: [] }
  const sent: import('@solus/contracts/doc-comments').DocCommentMutation[] = []
  adapter.list = async () => [thread]
  adapter.mutate = async (_ref, mutation) => { sent.push(mutation); return { threadId: 'footer:new' } }
  try {
    const workId = await work()
    await works.setWorkMirroredDoc(workId, { provider: 'confluence', externalId: '123', externalKey: 'site/SPACE', scope: 'SPACE', url: 'https://example.atlassian.net/wiki/pages/123', syncState: 'ok' })
    await annotations.saveWorkAnnotations({ version: 1, workId, updatedAt: 0, comments: [{ id: 'private', selectedText: 'hello', comment: 'Private instructions' }] })
    const snapshot = await service.refreshWorkExternalComments(workId)
    expect(snapshot).toMatchObject({ provider: 'confluence', externalKey: 'site/SPACE', documentId: '123', threads: [thread] })
    expect((await annotations.loadWorkAnnotations(workId))?.comments[0].comment).toBe('Private instructions')
    const command = { kind: 'share' as const, requestId: randomUUID(), text: 'One public message', target: { provider: 'confluence' as const, documentId: '123', externalKey: 'site/SPACE' } }
    await service.sendWorkExternalComment(workId, command)
    await service.sendWorkExternalComment(workId, command)
    expect(sent).toEqual([{ action: 'create', text: 'One public message', quote: undefined }])
    await expect(service.sendWorkExternalComment(workId, { kind: 'resolve', requestId: randomUUID(), threadId: thread.id })).rejects.toThrow('unavailable')
    expect(sent).toHaveLength(1)
    await works.setWorkMirroredDoc(workId, { provider: 'confluence', externalId: '123', externalKey: 'other/SPACE', scope: 'SPACE', url: 'https://other.atlassian.net/wiki/pages/123', syncState: 'ok' })
    expect((await service.readWorkExternalComments(workId)).threads).toEqual([])
    await expect(service.sendWorkExternalComment(workId, { ...command, requestId: randomUUID() })).rejects.toThrow('link changed')
  } finally { adapter.list = originalList; adapter.mutate = originalMutate }
})

test('legacy Google receipts migrate without posting again', async () => {
  const workId = await work()
  const command = { kind: 'share' as const, requestId: randomUUID(), text: 'Already posted' }
  const { getDb } = await import('@solus/server/db')
  getDb().prepare('INSERT INTO work_annotations (work_id, data, updated_at) VALUES (?, ?, ?)').run(workId, JSON.stringify({ version: 1, workId, comments: [], updatedAt: 0, googleComments: { documentId: 'test-doc', threads: [], operations: [{ requestId: command.requestId, command, status: 'sent' }] } }), 0)
  const before = postCount
  expect((await service.readWorkExternalComments(workId)).provider).toBe('gdrive')
  await service.sendWorkExternalComment(workId, command)
  expect(postCount).toBe(before)
  await service.refreshWorkExternalComments(workId)
  expect((await annotations.loadWorkAnnotations(workId))?.externalComments?.operations[0].status).toBe('sent')
})

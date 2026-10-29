import { afterEach, expect, mock, test } from 'bun:test'
import type { DocRef } from '@solus/contracts/docs'

mock.module('@solus/server/google/oauth', () => ({ getAccessToken: async () => 'fixture-token' }))
const { GoogleDocComments } = await import('@solus/server/docs/gdrive/comments')
const google = new GoogleDocComments()
const ref: DocRef = { provider: 'gdrive', externalId: 'doc', externalKey: 'root', url: 'https://docs.google.com/document/d/doc/edit' }
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })
const modifiedAt = '2026-09-09T00:00:00Z'
const thread = { id: 'thread', content: 'Review', author: { me: true, displayName: 'Owner' }, createdTime: modifiedAt, modifiedTime: modifiedAt, resolved: true, replies: [{ id: 'reply', content: 'Answer', author: { me: true }, createdTime: modifiedAt, modifiedTime: modifiedAt }] }

function respond(value = thread) {
  const calls: { url: string; method: string; body?: string }[] = []
  globalThis.fetch = (async (url, options) => {
    const method = options?.method ?? 'GET'
    calls.push({ url: String(url), method, body: typeof options?.body === 'string' ? options.body : undefined })
    return method === 'GET' ? Response.json({ comments: [value] }) : new Response(null, { status: 204 })
  }) as typeof fetch
  return calls
}



test('published quote survives provider read-back and restores an exact Solus range', async () => {
  const { Schema } = await import('@tiptap/pm/model')
  const { googleQuoteRange } = await import('@solus/workspace-ui/components/work/lib/google-comment-quote')
  const schema = new Schema({ nodes: { doc: { content: 'paragraph+' }, paragraph: { content: 'text*' }, text: {} } })
  let posted: { content: string; quotedFileContent?: { mimeType: string; value: string } } | undefined
  globalThis.fetch = (async (_url, options) => {
    if (options?.method === 'POST') {
      posted = JSON.parse(String(options.body))
      return Response.json({ id: 'shared' })
    }
    return Response.json({ comments: [{ ...thread, ...posted, id: 'shared', resolved: false }] })
  }) as typeof fetch
  const quote = 'The meeting starts at ten.'
  await google.mutate(ref, { action: 'create', text: 'Confirm this time', quote })
  const [imported] = await google.list(ref)
  expect(imported.textAnchor).toEqual({ quote, attachmentState: 'unknown' })
  const doc = schema.node('doc', null, [schema.node('paragraph', null, schema.text(`Before. ${quote} After.`))])
  const range = googleQuoteRange(doc, imported.textAnchor!.quote!)!
  expect(doc.textBetween(range.from, range.to)).toBe(quote)
  await google.mutate(ref, { action: 'create', text: 'Page discussion' })
  expect(posted?.quotedFileContent).toBeUndefined()
  expect((await google.list(ref))[0].textAnchor).toBeUndefined()
})

test('reply, resolve and reopen use the existing thread', async () => {
  for (const action of ['reply', 'resolve', 'reopen'] as const) {
    const calls = respond()
    await google.mutate(ref, action === 'reply' ? { action, threadId: 'thread', text: 'Answer' } : { action, threadId: 'thread' })
    expect(calls[1].url).toContain('/comments/thread/replies')
    expect(JSON.parse(calls[1].body!)).toEqual(action === 'reply' ? { content: 'Answer' } : { action })
  }
})

test('edit and delete target comments or replies and do not rewrite the doc', async () => {
  const calls = respond()
  await google.mutate(ref, { action: 'edit', threadId: 'thread', replyId: 'reply', expectedModifiedAt: modifiedAt, text: 'New answer' })
  expect(calls[1]).toMatchObject({ method: 'PATCH', body: '{"content":"New answer"}' })
  expect(calls[1].url).toContain('/comments/thread/replies/reply?')
  await google.mutate(ref, { action: 'delete', threadId: 'thread', expectedModifiedAt: modifiedAt })
  expect(calls[3].method).toBe('DELETE')
  expect(calls[3].body).toBeUndefined()
})

test('refuses stale edits and edits to other authors without sending a mutation', async () => {
  let calls = respond()
  await expect(google.mutate(ref, { action: 'edit', threadId: 'thread', expectedModifiedAt: 'old', text: 'Overwrite' })).rejects.toThrow('changed')
  expect(calls).toHaveLength(1)
  calls = respond({ ...thread, author: { me: false, displayName: 'Other' } })
  await expect(google.mutate(ref, { action: 'delete', threadId: 'thread', expectedModifiedAt: modifiedAt })).rejects.toThrow('author')
  expect(calls).toHaveLength(1)
})



test('Google normalizes actions and quoted text at the adapter boundary', async () => {
  respond({ ...thread, quotedFileContent: { value: 'Review target', mimeType: 'text/plain' } } as typeof thread)
  const [normalized] = await google.list(ref)
  expect(normalized.allowedActions).toEqual(['reply', 'reopen', 'edit', 'delete'])
  expect(normalized.textAnchor).toEqual({ quote: 'Review target', attachmentState: 'unknown' })
  respond({ ...thread, author: { me: false, displayName: 'Other' } })
  expect((await google.list(ref))[0].allowedActions).toEqual(['reply', 'reopen'])
})

test('Google returns acknowledged IDs without a second read', async () => {
  const calls: string[] = []
  globalThis.fetch = (async (url, options) => {
    calls.push(String(url))
    return options?.method === 'POST' ? Response.json({ id: 'created' }) : Response.json({ comments: [thread] })
  }) as typeof fetch
  expect(await google.mutate(ref, { action: 'create', text: 'New' })).toEqual({ threadId: 'created' })
  expect(calls).toHaveLength(1)
  expect(await google.mutate(ref, { action: 'reply', threadId: 'thread', text: 'Answer' })).toEqual({ threadId: 'thread', replyId: 'created' })
})

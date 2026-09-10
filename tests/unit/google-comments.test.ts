import { afterEach, expect, test } from 'bun:test'
import { listGoogleComments, postGoogleComment, GoogleCommentRequestError } from '@solus/server/google/comments'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })
const comment = { id: 'native', content: 'Review', createdTime: '2026-09-09T00:00:00Z', modifiedTime: '2026-09-09T00:00:00Z', anchor: 'kix.native', quotedFileContent: { mimeType: 'text/html', value: '<b>A &amp; B</b>' } }

test('reads native opaque anchors, decodes quotes, and reads every page including deleted threads', async () => {
  const urls: string[] = []
  globalThis.fetch = (async input => {
    urls.push(String(input))
    return Response.json(urls.length === 1 ? { comments: [comment], nextPageToken: 'next' } : { comments: [{ ...comment, id: 'deleted', deleted: true }] })
  }) as typeof fetch
  const threads = await listGoogleComments('test-token', 'doc/1')
  expect(threads).toHaveLength(2)
  expect(threads[0]).toMatchObject({ anchor: 'kix.native', quote: 'A & B', resolved: false })
  expect(threads[1].deleted).toBe(true)
  expect(urls[0]).toContain('doc%2F1')
  expect(urls[1]).toContain('pageToken=next')
  expect(urls[0]).toContain('includeDeleted=true')
})

test('partial pagination fails instead of returning a partial snapshot', async () => {
  let calls = 0
  globalThis.fetch = (async () => ++calls === 1 ? Response.json({ comments: [comment], nextPageToken: 'next' }) : new Response('', { status: 403 })) as typeof fetch
  await expect(listGoogleComments('test-token', 'doc')).rejects.toThrow('403')
})

test('unknown POST outcome is distinguished from definite permission rejection', async () => {
  globalThis.fetch = (async () => { throw new Error('network lost') }) as typeof fetch
  try { await postGoogleComment('test-token', 'doc', 'hello'); throw new Error('expected failure') }
  catch (error) { expect(error).toBeInstanceOf(GoogleCommentRequestError); expect((error as GoogleCommentRequestError).uncertain).toBe(true) }
  globalThis.fetch = (async () => new Response('', { status: 403 })) as typeof fetch
  try { await postGoogleComment('test-token', 'doc', 'hello'); throw new Error('expected failure') }
  catch (error) { expect((error as GoogleCommentRequestError).uncertain).toBe(false) }
})

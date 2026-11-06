import { afterEach, expect, test } from 'bun:test'
import { deleteFile } from '@solus/server/google/drive'
import { postGoogleComment } from '@solus/server/google/comments'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

test('a refused Drive call is sent once: the SDK retries a DELETE by default, and Solus turns that off', async () => {
  let calls = 0
  globalThis.fetch = (async () => { calls++; return new Response('busy', { status: 503 }) }) as typeof fetch
  await expect(deleteFile('token', 'file')).rejects.toThrow('Drive delete failed (503)')
  expect(calls).toBe(1)
})

test('a file already gone is the state a delete asks for', async () => {
  globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof fetch
  await deleteFile('token', 'file')
})

test('requests carry the access token through the runtime fetch, and a written comment gives back its id', async () => {
  const sent: Array<{ url: string; authorization: string | null; method: string | undefined }> = []
  globalThis.fetch = (async (input, init) => {
    sent.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization'), method: init?.method })
    return Response.json({ id: 'comment-1' })
  }) as typeof fetch
  expect(await postGoogleComment('token', 'doc', 'hello')).toBe('comment-1')
  expect(sent).toEqual([{ url: expect.stringContaining('/drive/v3/files/doc/comments'), authorization: 'Bearer token', method: 'POST' }])
})

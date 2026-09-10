import { afterEach, expect, test } from 'bun:test'
import { batchUpdateDocument, getEditableDocument } from '@solus/server/google/docs-api'
import { writeNewDocsBody } from '@solus/server/google/docs-publish'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

test('required revision is sent with the batch and a stale write is never retried', async () => {
  let writes = 0
  globalThis.fetch = (async (_input, init) => {
    writes++
    expect(JSON.parse(String(init?.body))).toEqual({
      requests: [{ insertText: { location: { index: 2, tabId: 'tab' }, text: 'x' } }],
      writeControl: { requiredRevisionId: 'revision-1' },
    })
    return new Response('stale revision', { status: 400 })
  }) as typeof fetch
  await expect(batchUpdateDocument('test', 'doc', [{ insertText: { location: { index: 2, tabId: 'tab' }, text: 'x' } }], 'revision-1')).rejects.toThrow('400')
  expect(writes).toBe(1)
})

test('network uncertainty does not replay a positional write', async () => {
  let writes = 0
  globalThis.fetch = (async () => { writes++; throw new Error('connection lost') }) as typeof fetch
  await expect(batchUpdateDocument('test', 'doc', [{ insertText: { location: { index: 2 }, text: 'x' } }], 'revision-1')).rejects.toThrow('connection lost')
  expect(writes).toBe(1)
})

test('no-op makes no network request', async () => {
  globalThis.fetch = (async () => { throw new Error('unexpected request') }) as typeof fetch
  await batchUpdateDocument('test', 'doc', [], 'revision-1')
})

test('creation writer refuses populated documents before any write or asset upload', async () => {
  let reads = 0
  globalThis.fetch = (async (_input, init) => {
    expect(init?.method ?? 'GET').toBe('GET')
    reads++
    return Response.json({ documentId: 'doc', body: { content: [{ startIndex: 1, endIndex: 8, paragraph: { elements: [{ textRun: { content: 'Keep me' } }] } }] } })
  }) as typeof fetch
  await expect(writeNewDocsBody('test', 'doc', 'New content', [])).rejects.toThrow('never replaced')
  expect(reads).toBe(1)
})

test('creation writer inserts content without issuing any deletion', async () => {
  const bodies: string[] = []
  globalThis.fetch = (async (_input, init) => {
    if (init?.method === 'POST') { bodies.push(String(init.body)); return Response.json({}) }
    return Response.json({ documentId: 'doc', body: { content: [{ startIndex: 1, endIndex: 2, paragraph: { elements: [{ textRun: { content: '\n' } }] } }] } })
  }) as typeof fetch
  await writeNewDocsBody('test', 'doc', 'New content', [])
  expect(bodies.join('')).toContain('insertText')
  expect(bodies.join('')).not.toContain('deleteContentRange')
})

test('edit reads require all tabs and reject unsupported content before planning', async () => {
  globalThis.fetch = (async input => {
    expect(String(input)).toContain('includeTabsContent=true')
    return Response.json({ revisionId: 'r1', tabs: [{ tabProperties: { tabId: 'tab' }, documentTab: { body: { content: [{ startIndex: 1, endIndex: 5, table: {} }] } } }] })
  }) as typeof fetch
  await expect(getEditableDocument('test', 'doc')).rejects.toThrow('not supported')
})

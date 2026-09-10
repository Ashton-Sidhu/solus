import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import type { DocRef } from '@solus/contracts/docs'
import type { AtlassianStoredCredential } from '@solus/server/atlassian/token-store'

const credential: AtlassianStoredCredential = {
  cloudId: 'site', siteUrl: 'https://example.atlassian.net', products: ['confluence'],
  accessToken: 'fixture', refreshToken: 'fixture', expiresAt: Date.now() + 600000,
  scopes: ['read:comment:confluence', 'write:comment:confluence', 'delete:comment:confluence'],
}
mock.module('@solus/server/atlassian/oauth', () => ({ currentCredential: async () => credential }))
const { ConfluenceDocComments } = await import('@solus/server/docs/confluence/comments')
const { DocCommentRequestError } = await import('@solus/server/docs/types')
let comments = new ConfluenceDocComments()
const ref: DocRef = { provider: 'confluence', externalId: 'page', externalKey: 'site/SPACE', url: 'https://example.atlassian.net/wiki/spaces/SPACE/pages/page' }
const originalFetch = globalThis.fetch
const first = '2026-09-01T00:00:00Z'
const modified = '2026-09-09T00:00:00Z'
const footer = { id: '1', pageId: 'page', status: 'current', version: { number: 2, createdAt: modified, authorId: 'editor' }, body: { storage: { value: '<p>A &amp; <strong>B</strong></p>' } } }
const inline = { id: '2', pageId: 'page', status: 'current', version: { number: 1, createdAt: first, authorId: 'owner' }, body: { storage: { value: '<p>Review</p>' } }, resolutionStatus: 'resolved', properties: { inlineOriginalSelection: 'Quoted sentence', inlineMarkerRef: 'marker' } }
const reply = { id: '3', parentCommentId: '1', status: 'current', version: { number: 1, createdAt: first, authorId: 'owner' }, body: { storage: { value: '<p>Reply</p>' } } }
interface Call { path: string; method: string; body?: string }
let calls: Call[] = []
let override: ((url: URL, init?: RequestInit) => Response | undefined | Promise<Response | undefined>) | undefined
function fixture() {
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input))
    const path = url.pathname.replace('/ex/confluence/site', '')
    calls.push({ path, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : undefined })
    const response = await override?.(url, init)
    if (response) return response
    if (path === '/wiki/api/v2/users-bulk') return Response.json({ results: [{ accountId: 'owner', displayName: 'Original author' }] })
    if (init?.method !== 'GET') return new Response(null, { status: 204 })
    if (path === '/wiki/api/v2/pages/page') return Response.json({ body: { storage: { value: '<p>A &amp; B</p><p><ac:inline-comment-marker ac:ref="marker">Quoted sentence</ac:inline-comment-marker></p>' } } })
    if (path === '/wiki/rest/api/user/current') return Response.json({ accountId: 'owner' })
    if (path.endsWith('/versions/1')) return Response.json({ number: 1, authorId: 'owner', createdAt: first })
    if (path === '/wiki/api/v2/footer-comments/1') return Response.json(footer)
    if (path === '/wiki/api/v2/inline-comments/2') return Response.json(inline)
    if (path === '/wiki/api/v2/footer-comments/3') return Response.json(reply)
    if (path === '/wiki/api/v2/footer-comments/999') return new Response(null, { status: 404 })
    if (path === '/wiki/api/v2/pages/page/footer-comments') {
      return Response.json(url.searchParams.has('cursor') ? { results: [] } : { results: [footer], _links: { next: '/wiki/api/v2/pages/page/footer-comments?cursor=next' } })
    }
    if (path === '/wiki/api/v2/pages/page/inline-comments') {
      expect(url.searchParams.get('resolution-status')).toBe('open,resolved,reopened,dangling')
      return Response.json({ results: [inline] })
    }
    if (path === '/wiki/api/v2/footer-comments/1/children') return Response.json({ results: [reply] })
    if (path.endsWith('/children')) return Response.json({ results: [] })
    throw new Error(`Unexpected path ${path}`)
  }) as typeof fetch
}
beforeEach(() => { comments = new ConfluenceDocComments() })
afterEach(() => { globalThis.fetch = originalFetch; calls = []; override = undefined })

test('lists both thread kinds, paginates, reads replies, and preserves original authors', async () => {
  fixture()
  const result = await comments.list(ref)
  expect(result).toHaveLength(2)
  expect(result[0]).toMatchObject({ id: 'footer:1', location: 'page', text: 'A & **B**', author: { name: 'Original author', isMe: true }, createdAt: first, modifiedAt: modified })
  expect(result[0].replies[0].id).toBe('footer:3')
  expect(result[1]).toMatchObject({ id: 'inline:2', location: 'inline', resolved: true, quote: 'Quoted sentence', anchor: 'marker', attachmentState: 'attached' })
  expect(calls.filter(call => call.path.endsWith('/pages/page/footer-comments'))).toHaveLength(2)
})

test('partial and looping pagination fail without returning a partial snapshot', async () => {
  fixture()
  override = url => url.searchParams.has('cursor') ? new Response('', { status: 403 }) : undefined
  await expect(comments.list(ref)).rejects.toThrow('permissions')
  override = url => url.searchParams.has('cursor') ? Response.json({ results: [], _links: { next: '?cursor=next' } }) : undefined
  await expect(comments.list(ref)).rejects.toThrow('pagination')
})

test('creates only the selected escaped message as a native inline comment', async () => {
  fixture()
  await comments.mutate(ref, { action: 'create', text: '<script>private?</script>', quote: 'A & B' })
  expect(calls).toHaveLength(2)
  expect(calls[1].path).toBe('/wiki/api/v2/inline-comments')
  const body = JSON.parse(calls[1].body!)
  expect(body.pageId).toBe('page')
  expect(body.body.value).toContain('&lt;script&gt;')
  expect(body.body.value).not.toContain('A &amp; B')
  expect(body.inlineCommentProperties).toEqual({ textSelection: 'A & B', textSelectionMatchCount: 1, textSelectionMatchIndex: 0 })
})

test('replies target the correct thread kind; resolve/reopen preserve the body', async () => {
  fixture()
  for (const threadId of ['footer:1', 'inline:2']) {
    await comments.mutate(ref, { action: 'reply', threadId, text: 'Answer' })
    expect(calls.at(-1)?.path).toBe(`/wiki/api/v2/${threadId.split(':')[0]}-comments`)
    expect(JSON.parse(calls.at(-1)!.body!).parentCommentId).toBe(threadId.split(':')[1])
  }
  for (const action of ['resolve', 'reopen'] as const) {
    override = url => url.pathname.endsWith('/inline-comments/2')
      ? Response.json({ ...inline, resolutionStatus: action === 'resolve' ? 'open' : 'resolved' }) : undefined
    await comments.mutate(ref, { action, threadId: 'inline:2' })
    expect(calls.at(-1)?.method).toBe('PUT')
    expect(JSON.parse(calls.at(-1)!.body!)).toEqual({ version: { number: 2 }, resolved: action === 'resolve' })
  }
  const writes = calls.filter(call => call.method !== 'GET').length
  await expect(comments.mutate(ref, { action: 'resolve', threadId: 'footer:1' })).rejects.toThrow('Only inline')
  expect(calls.filter(call => call.method !== 'GET')).toHaveLength(writes)
})

test('edits use a version precondition and stale edits or foreign replies cannot write', async () => {
  fixture()
  await comments.mutate(ref, { action: 'edit', threadId: 'footer:1', expectedModifiedAt: modified, text: 'Updated' })
  expect(JSON.parse(calls.at(-1)!.body!).version).toEqual({ number: 3 })
  const writes = calls.filter(call => call.method !== 'GET').length
  await expect(comments.mutate(ref, { action: 'edit', threadId: 'footer:1', expectedModifiedAt: first, text: 'Stale' })).rejects.toThrow('changed')
  await expect(comments.mutate(ref, { action: 'delete', threadId: 'inline:2', replyId: 'footer:3', expectedModifiedAt: first })).rejects.toThrow('not part')
  await expect(comments.mutate(ref, { action: 'delete', threadId: 'footer:999', expectedModifiedAt: first })).rejects.toThrow('selected page')
  expect(calls.filter(call => call.method !== 'GET')).toHaveLength(writes)
})

test('delete targets only the selected reply using the shared transport', async () => {
  fixture()
  await comments.mutate(ref, { action: 'delete', threadId: 'footer:1', replyId: 'footer:3', expectedModifiedAt: first })
  expect(calls.at(-1)).toEqual({ path: '/wiki/api/v2/footer-comments/3', method: 'DELETE', body: undefined })
})

test('permission or version refusal is definite; a failed write is never retried', async () => {
  fixture()
  for (const status of [403, 409, 500]) {
    calls = []
    override = (_url, init) => init?.method === 'POST' ? new Response('', { status }) : undefined
    try { await comments.mutate(ref, { action: 'create', text: 'One send' }); throw new Error('expected failure') }
    catch (error) { expect(error).toBeInstanceOf(DocCommentRequestError); expect((error as InstanceType<typeof DocCommentRequestError>).uncertain).toBe(status === 500) }
    expect(calls).toHaveLength(1)
  }
  calls = []
  override = () => { throw new Error('lost connection') }
  await expect(comments.mutate(ref, { action: 'create', text: 'One send' })).rejects.toThrow('before sending again')
  expect(calls).toHaveLength(1)
})

test('wrong site and missing scopes fail before network access', async () => {
  fixture()
  await expect(comments.list({ ...ref, externalKey: 'other/SPACE' })).rejects.toThrow('site')
  const scopes = credential.scopes
  credential.scopes = []
  try { await expect(comments.mutate(ref, { action: 'create', text: 'One send' })).rejects.toThrow('Reconnect') }
  finally { credential.scopes = scopes }
  expect(calls).toHaveLength(0)
})

test('detached threads stay distinct from resolved threads and reject updates', async () => {
  fixture()
  override = url => url.pathname.endsWith('/pages/page/inline-comments')
    ? Response.json({ results: [{ ...inline, resolutionStatus: 'dangling' }] })
    : url.pathname.endsWith('/inline-comments/2') ? Response.json({ ...inline, resolutionStatus: 'dangling' }) : undefined
  const result = await comments.list(ref)
  expect(result[1]).toMatchObject({ attachmentState: 'detached', resolved: false })
  calls = []
  await expect(comments.mutate(ref, { action: 'resolve', threadId: 'inline:2' })).rejects.toThrow('detached')
  expect(calls.every(call => call.method === 'GET')).toBe(true)
})

test('Confluence document adapter exposes the shared capability', async () => {
  const { ConfluenceDocAdapter } = await import('@solus/server/docs/confluence/adapter')
  const adapter = new ConfluenceDocAdapter()
  expect(adapter.comments).toBeInstanceOf(ConfluenceDocComments)
  expect(adapter.comments.actions).toEqual(['create', 'reply', 'edit', 'delete', 'resolve', 'reopen'])
})

test('adapter declares thread actions and normalized highlight anchors', async () => {
  fixture()
  const [page, anchored] = await comments.list(ref)
  expect(page.allowedActions).toEqual(['reply', 'edit', 'delete'])
  expect(page.textAnchor).toBeUndefined()
  expect(anchored.allowedActions).toContain('reopen')
  expect(anchored.allowedActions).not.toContain('resolve')
  expect(anchored.textAnchor).toEqual({ quote: 'Quoted sentence', attachmentState: 'attached' })
})

test('create and reply return normalized IDs from acknowledgements', async () => {
  fixture()
  override = (_url, init) => init?.method === 'POST' ? Response.json({ id: 'new-comment' }) : undefined
  expect(await comments.mutate(ref, { action: 'create', text: 'New' })).toEqual({ threadId: 'footer:new-comment' })
  expect(await comments.mutate(ref, { action: 'reply', threadId: 'inline:2', text: 'Answer' })).toEqual({ threadId: 'inline:2', replyId: 'inline:new-comment' })
})


test('current native marker text replaces the historical quote; missing markers detach', async () => {
  fixture()
  override = url => url.pathname.endsWith('/pages/page') ? Response.json({ body: { storage: { value: '<p><ac:inline-comment-marker ac:ref="marker">Updated sentence</ac:inline-comment-marker></p>' } } }) : undefined
  expect((await comments.list(ref))[1].textAnchor).toEqual({ quote: 'Updated sentence', attachmentState: 'attached' })
  override = url => url.pathname.endsWith('/pages/page') ? Response.json({ body: { storage: { value: '<p>Updated sentence</p>' } } }) : undefined
  const detached = (await comments.list(ref))[1]
  expect(detached.textAnchor?.attachmentState).toBe('detached')
  expect(detached.allowedActions).toEqual(['reply', 'delete'])
})

test('missing or repeated selections fail definitely before creating a comment', async () => {
  fixture()
  for (const value of ['<p>Missing</p>', '<p>A &amp; B A &amp; B</p>']) {
    override = url => url.pathname.endsWith('/pages/page') ? Response.json({ body: { storage: { value } } }) : undefined
    await expect(comments.mutate(ref, { action: 'create', text: 'Selected only', quote: 'A & B' })).rejects.toMatchObject({ uncertain: false })
  }
  expect(calls.every(call => call.method === 'GET')).toBe(true)
})

test('page update writes native markers with the version guard and rejects same-version marker races', async () => {
  fixture()
  const { ConfluenceDocAdapter } = await import('@solus/server/docs/confluence/adapter')
  const adapter = new ConfluenceDocAdapter()
  const value = '<p><ac:inline-comment-marker ac:ref="marker">The meeting starts at ten.</ac:inline-comment-marker></p>'
  const page = { id: 'page', title: 'Review', version: { number: 3 }, body: { storage: { value } } }
  override = (_url, init) => init?.method === 'PUT'
    ? Response.json({ ...page, body: { storage: { value: JSON.parse(String(init.body)).body.value } }, version: { number: 4 } }) : Response.json(page)
  const updated = await adapter.update(ref, { markdown: 'The meeting starts at eleven.', expectedVersion: '3' })
  expect(updated.markdown).toBe('The meeting starts at eleven.')
  const sent = JSON.parse(calls.find(call => call.method === 'PUT')!.body!)
  expect(sent.body.value).toContain('ac:ref="marker"')
  expect(sent.version.number).toBe(4)
  calls = []
  let reads = 0
  override = () => Response.json(++reads === 1 ? page : { ...page, body: { storage: { value: value + '<p>New review</p>' } } })
  await expect(adapter.update(ref, { markdown: 'The meeting starts at eleven.', expectedVersion: '3' })).rejects.toThrow()
  expect(calls.every(call => call.method === 'GET')).toBe(true)
  calls = []
  override = () => Response.json(page)
  await expect(adapter.update(ref, { markdown: 'Removed.', expectedVersion: '3' })).rejects.toThrow('Cannot keep')
  expect(calls.every(call => call.method === 'GET')).toBe(true)
})

test('unreadable markers do not hide page comments or other inline threads', async () => {
  fixture()
  override = url => {
    if (url.pathname.endsWith('/pages/page/inline-comments')) return Response.json({ results: [
      inline, { ...inline, id: '4', properties: { inlineMarkerRef: 'hidden', inlineOriginalSelection: 'Hidden text' } },
    ] })
    if (url.pathname.endsWith('/pages/page')) return Response.json({ body: { storage: { value:
      '<ul><li><ac:inline-comment-marker ac:ref="marker">Parent item</ac:inline-comment-marker><ul><li>Child item</li></ul></li></ul>'
      + '<ac:structured-macro><ac:inline-comment-marker ac:ref="hidden">Hidden text</ac:inline-comment-marker></ac:structured-macro>',
    } } })
  }
  const threads = await comments.list(ref)
  expect(threads).toHaveLength(3)
  expect(threads[0].id).toBe('footer:1')
  expect(threads[1].textAnchor).toEqual({ quote: 'Parent item', attachmentState: 'attached' })
  expect(threads[2].textAnchor).toEqual({ quote: '', attachmentState: 'unknown' })
  expect(threads[2].allowedActions).toEqual(['reply', 'delete'])
})

test('direct mutations enforce missing and unreadable anchor rules while replies and deletion remain available', async () => {
  fixture()
  for (const value of ['<p>No marker</p>', '<ac:structured-macro><ac:inline-comment-marker ac:ref="marker">Hidden</ac:inline-comment-marker></ac:structured-macro>']) {
    override = url => url.pathname.endsWith('/pages/page') ? Response.json({ body: { storage: { value } } }) : undefined
    for (const action of ['resolve', 'reopen', 'edit'] as const) {
      calls = []
      await expect(comments.mutate(ref, action === 'edit'
        ? { action, threadId: 'inline:2', text: 'Edit', expectedModifiedAt: first }
        : { action, threadId: 'inline:2' })).rejects.toMatchObject({ uncertain: false })
      expect(calls.every(call => call.method === 'GET')).toBe(true)
    }
    await comments.mutate(ref, { action: 'reply', threadId: 'inline:2', text: 'Follow-up' })
    expect(calls.at(-1)?.method).toBe('POST')
    await comments.mutate(ref, { action: 'delete', threadId: 'inline:2', expectedModifiedAt: first })
    expect(calls.at(-1)?.method).toBe('DELETE')
  }
})

test('a reply validates only its selected root and does not load unrelated discussions or authors', async () => {
  fixture()
  await comments.mutate(ref, { action: 'reply', threadId: 'footer:1', text: 'Answer' })
  expect(calls.map(call => [call.method, call.path])).toEqual([
    ['GET', '/wiki/api/v2/footer-comments/1'], ['POST', '/wiki/api/v2/footer-comments'],
  ])
})

test('focused mutation reads still reject foreign, missing, deleted and mismatched roots', async () => {
  fixture()
  for (const root of [
    { ...footer, pageId: 'other' }, { ...footer, pageId: undefined },
    { ...footer, parentCommentId: 'other-root' }, { ...footer, status: 'deleted' }, { ...footer, id: 'wrong' },
  ]) {
    calls = []
    override = url => url.pathname.endsWith('/footer-comments/1') ? Response.json(root) : undefined
    await expect(comments.mutate(ref, { action: 'reply', threadId: 'footer:1', text: 'No send' })).rejects.toMatchObject({ uncertain: false })
    expect(calls.every(call => call.method === 'GET')).toBe(true)
  }
})

test('nested reply targets prove their ancestor chain without loading sibling discussions', async () => {
  fixture()
  override = url => url.pathname.endsWith('/footer-comments/4') ? Response.json({ ...reply, id: '4', parentCommentId: '3' }) : undefined
  await comments.mutate(ref, { action: 'edit', threadId: 'footer:1', replyId: 'footer:4', expectedModifiedAt: first, text: 'Nested edit' })
  expect(calls.map(call => call.path)).toEqual([
    '/wiki/api/v2/footer-comments/1', '/wiki/api/v2/footer-comments/4', '/wiki/api/v2/footer-comments/3', '/wiki/api/v2/footer-comments/4',
  ])
  for (const parentCommentId of ['4', undefined]) {
    calls = []
    override = url => url.pathname.endsWith('/footer-comments/4') ? Response.json({ ...reply, id: '4', parentCommentId }) : undefined
    await expect(comments.mutate(ref, { action: 'delete', threadId: 'footer:1', replyId: 'footer:4', expectedModifiedAt: first })).rejects.toThrow('not part')
    expect(calls.every(call => call.method === 'GET')).toBe(true)
  }
  calls = []
  override = url => url.pathname.endsWith('/footer-comments/3') ? Response.json({ ...reply, pageId: 'other' }) : undefined
  await expect(comments.mutate(ref, { action: 'delete', threadId: 'footer:1', replyId: 'footer:3', expectedModifiedAt: first })).rejects.toThrow('not part')
  expect(calls.every(call => call.method === 'GET')).toBe(true)
})

test('repeat refresh reuses original author metadata but reads current bodies and versions', async () => {
  fixture()
  await comments.list(ref)
  expect(calls.filter(call => call.path.endsWith('/versions/1'))).toHaveLength(1)
  calls = []
  override = url => url.pathname.endsWith('/pages/page/footer-comments') ? Response.json({ results: [
    { ...footer, version: { ...footer.version, number: 3, createdAt: first }, body: { storage: { value: '<p>Current body</p>' } } },
  ] }) : undefined
  const result = await comments.list(ref)
  expect(result[0]).toMatchObject({ text: 'Current body', author: { name: 'Original author' }, createdAt: first, modifiedAt: first })
  expect(calls.filter(call => call.path.endsWith('/versions/1'))).toHaveLength(0)
  expect(calls.some(call => call.path.endsWith('/pages/page/footer-comments'))).toBe(true)
  expect(calls.some(call => call.path.endsWith('/user/current'))).toBe(true)
})

test('original author cache is bounded and does not cross connected accounts', async () => {
  fixture()
  await comments.list(ref)
  calls = []
  override = url => url.pathname.endsWith('/user/current') ? Response.json({ accountId: 'another-account' }) : undefined
  await comments.list(ref)
  expect(calls.filter(call => call.path.endsWith('/versions/1'))).toHaveLength(1)
  override = url => {
    if (url.pathname.endsWith('/pages/page/footer-comments')) return Response.json({ results: Array.from({ length: 1001 }, (_, i) => ({ ...footer, id: `bulk-${i}`, version: { number: 1, createdAt: first, authorId: 'owner' } })) })
    if (url.pathname.endsWith('/pages/page/inline-comments')) return Response.json({ results: [] })
  }
  await comments.list(ref)
  calls = []
  override = undefined
  await comments.list(ref)
  expect(calls.filter(call => call.path.endsWith('/versions/1'))).toHaveLength(1)
})

test('independent thread reads run concurrently with a fixed bound and retain provider order', async () => {
  fixture()
  let active = 0
  let maximum = 0
  let started = 0
  let ready!: () => void
  const firstBatchReady = new Promise<void>(resolve => { ready = resolve })
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const roots = Array.from({ length: 9 }, (_, index) => ({ ...footer, id: `parallel-${index}`, version: { number: 1, createdAt: first, authorId: 'owner' } }))
  override = async url => {
    if (url.pathname.endsWith('/pages/page/footer-comments')) return Response.json({ results: roots })
    if (url.pathname.endsWith('/pages/page/inline-comments')) return Response.json({ results: [] })
    if (url.pathname.includes('/footer-comments/parallel-') && url.pathname.endsWith('/children')) {
      active++
      started++
      maximum = Math.max(maximum, active)
      if (started === 4) ready()
      await barrier
      active--
      return Response.json({ results: [] })
    }
  }
  const pending = comments.list(ref)
  try { await firstBatchReady; expect(active).toBe(4) }
  finally { release() }
  const result = await pending
  expect(maximum).toBe(4)
  expect(result.map(thread => thread.id)).toEqual(roots.map(root => `footer:${root.id}`))
})

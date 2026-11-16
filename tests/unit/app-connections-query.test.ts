import { afterAll, expect, mock, spyOn, test } from 'bun:test'

// The person's Google sign-in, for this file only: the request never leaves the test.
mock.module('@solus/server/google/oauth', () => ({ getAccessToken: async () => 'test-token' }))
const atlassianRequests: { product: string; method: string; path: string; query: unknown }[] = []
mock.module('@solus/server/atlassian/api', () => ({
  connectedSite: async () => ({ cloudId: 'cloud-1', siteUrl: 'https://acme.atlassian.net' }),
  atlassianRequest: async (request: { product: string; method: string; path: string; query: unknown }) => {
    atlassianRequests.push({ product: request.product, method: request.method, path: request.path, query: request.query })
    return { ok: true }
  },
}))
const { hostConnections } = await import('@solus/server/apps/app-connections')

const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{"files":[]}', { headers: { 'content-type': 'application/json' } }))
afterAll(() => fetchSpy.mockRestore())

test('a number or a boolean in query is sent as its text', async () => {
  // WHY: apps write `per_page: 100`; a URL takes text, so the request must not refuse a number.
  expect(await hostConnections.request('google', { path: '/drive/v3/files', query: { pageSize: 100, supportsAllDrives: true, q: 'name' } })).toEqual({ files: [] })
  const url = new URL(String(fetchSpy.mock.calls[0]?.[0]))
  expect(url.origin).toBe('https://www.googleapis.com')
  expect(Object.fromEntries(url.searchParams)).toEqual({ pageSize: '100', supportsAllDrives: 'true', q: 'name' })
})

test('a request the tool does not take says what is wrong in one line', async () => {
  await expect(hostConnections.request('google', { path: '/drive/v3/files', query: { filter: { nested: 1 } } }))
    .rejects.toThrow(/^This request is not one the request tool takes: .*query\.filter/)
})

test('a method in lower case, a list, and a null in query are what an app means', async () => {
  // WHY: apps write `method: 'get'` and `fields: ['summary', 'status']`; refusing them is a failure the user cannot fix.
  fetchSpy.mockClear()
  await hostConnections.request('google', { method: 'get', path: '/drive/v3/files', query: { fields: ['id', 'name'], pageToken: null } })
  const [url, init] = fetchSpy.mock.calls[0] ?? []
  expect(Object.fromEntries(new URL(String(url)).searchParams)).toEqual({ fields: 'id,name' })
  expect(init?.method).toBe('GET')
})

test('an Atlassian request that names no product is for Confluence under /wiki/ and for Jira otherwise', async () => {
  await hostConnections.request('atlassian', { path: '/wiki/api/v2/pages/1' })
  await hostConnections.request('atlassian', { method: 'post', path: '/rest/api/3/search/jql', body: { jql: 'project = ENG' } })
  await hostConnections.request('atlassian', { product: 'jira', path: '/wiki/odd' })
  expect(atlassianRequests).toEqual([
    { product: 'confluence', method: 'GET', path: '/wiki/api/v2/pages/1', query: undefined },
    { product: 'jira', method: 'POST', path: '/rest/api/3/search/jql', query: undefined },
    { product: 'jira', method: 'GET', path: '/wiki/odd', query: undefined },
  ])
})

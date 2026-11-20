import { afterEach, expect, spyOn, test } from 'bun:test'
import { fetchLatestRelease } from '@solus/server/updates/release-sources'

afterEach(() => { (globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.() })

test('the host release source reads Solus without knowing about agent installations', async () => {
  const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ tag_name: 'v1.2.0', html_url: 'https://github.com/example/solus/releases/tag/v1.2.0' }))
  expect(await fetchLatestRelease('1.0.0')).toEqual({ version: '1.2.0', url: 'https://github.com/example/solus/releases/tag/v1.2.0' })
  expect(fetch.mock.calls[0]?.[1]?.headers).toEqual({ 'user-agent': 'solus-server/1.0.0' })
})

test('a blocked host release source reports the HTTP failure', async () => {
  spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 403 }))
  await expect(fetchLatestRelease('1.0.0')).rejects.toThrow('HTTP 403')
})

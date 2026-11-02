import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { fetchLatestRelease, type NpmView } from '@solus/server/updates/release-sources'

// A corporate registry or proxy blocks registry.npmjs.org. When npm is on the
// host, the provider version comes from npm itself, so its registry, auth, and
// proxy settings apply, and a failed lookup never falls back to public npm.

afterEach(() => {
  ;(globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.()
})

function noPublicRegistry() {
  return spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('a lookup through npm must not reach public npm')
  })
}

describe('provider release lookup', () => {
  test('asks npm for the latest version when npm is on the host', async () => {
    const fetchSpy = noPublicRegistry()
    const specs: string[] = []
    const view: NpmView = async (spec) => { specs.push(spec); return '"2.1.0"\n' }

    expect(await fetchLatestRelease('claude', '1.0.0', view)).toEqual({
      version: '2.1.0',
      url: 'https://www.npmjs.com/package/@anthropic-ai/claude-code',
    })
    expect(await fetchLatestRelease('codex', '1.0.0', view)).toMatchObject({ version: '2.1.0' })
    expect(specs).toEqual(['@anthropic-ai/claude-code@latest', '@openai/codex@latest'])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test.each([
    ['npm failed', async () => { throw new Error('npm could not read @anthropic-ai/claude-code@latest.') }],
    ['npm printed no version', async () => 'not json'],
    ['npm printed an error object', async () => '{"error":{"code":"E401"}}'],
  ] as Array<[string, NpmView]>)('reports a failed lookup without trying public npm: %s', async (_case, view) => {
    const fetchSpy = noPublicRegistry()
    await expect(fetchLatestRelease('claude', '1.0.0', view)).rejects.toThrow(/npm/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test('reads public npm only when npm is not on the host', async () => {
    const urls: string[] = []
    spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      urls.push(String(input))
      return Response.json({ version: '3.0.0' })
    })

    expect(await fetchLatestRelease('codex', '1.0.0', async () => null)).toMatchObject({ version: '3.0.0' })
    expect(urls).toEqual(['https://registry.npmjs.org/@openai/codex/latest'])
  })
})

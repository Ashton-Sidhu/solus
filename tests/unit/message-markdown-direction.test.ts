import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { createServer, type ViteDevServer } from 'vite'
import { settledMarkdownBlocks } from '@solus/workspace-ui/components/conversation/lib/settled-markdown'

// WHY: a Hebrew or Arabic reply put its bullets, numbers, and quote rules on
// the left. Text direction comes from `unicode-bidi: plaintext` in the prose
// styles, but only a `dir` on the list or quote moves its markers and its
// rule. A reply renders through two paths, the markdown component while it
// streams and marked's HTML when it is finished, so both must give the `dir`.
const SOURCE = 'שלום עולם\n\n- פריט ראשון\n- second\n\n3. שלישי\n\n> ציטוט'

describe('message markdown direction', () => {
  let server: ViteDevServer

  beforeAll(async () => {
    server = await createServer({
      configFile: false,
      root: 'packages/workspace-ui',
      optimizeDeps: { noDiscovery: true },
      plugins: [svelte({ compilerOptions: { runes: true, dev: false } })],
      server: { middlewareMode: true },
      appType: 'custom',
      logLevel: 'error',
    })
  })

  afterAll(async () => {
    await server.close()
  })

  it('gives lists and quotes dir="auto" in a finished reply', () => {
    const blocks = settledMarkdownBlocks(SOURCE, [])!
    expect(blocks).toHaveLength(1)
    const first = blocks[0]
    if (!('html' in first)) throw new Error('expected html')
    expect(first.html).toContain('<ul dir="auto">')
    expect(first.html).toContain('<ol dir="auto" start="3">')
    expect(first.html).toContain('<blockquote dir="auto">')
  })

  it('gives lists and quotes dir="auto" in a streaming reply', async () => {
    const [{ default: SvelteMarkdown }, { default: MarkdownList }, { default: MarkdownBlockquote }, { render }] = await Promise.all([
      server.ssrLoadModule('@humanspeak/svelte-markdown'),
      server.ssrLoadModule('/src/components/conversation/MarkdownList.svelte'),
      server.ssrLoadModule('/src/components/conversation/MarkdownBlockquote.svelte'),
      server.ssrLoadModule('svelte/server'),
    ])
    const { body } = render(SvelteMarkdown, {
      props: { source: SOURCE, renderers: { list: MarkdownList, blockquote: MarkdownBlockquote } },
    })
    expect(body).toMatch(/<ul dir="auto">/)
    expect(body).toMatch(/<ol start="3" dir="auto">/)
    expect(body).toMatch(/<blockquote dir="auto">/)
    // The items keep the library's own markup inside the list.
    expect(body).toContain('פריט ראשון')
  })
})

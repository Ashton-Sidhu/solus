import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { createServer, type Plugin, type ViteDevServer } from 'vite'

const COMPONENT_STUB = 'virtual:session-preview-stub.svelte'
const OPTIONS_STUB = 'virtual:assistant-markdown.ts'

function previewStubs(): Plugin {
  return {
    name: 'session-preview-test-stubs',
    enforce: 'pre',
    resolveId(source) {
      if (source.endsWith('assistant-markdown')) return OPTIONS_STUB
      if (
        [
          'CodeBlock.svelte',
          'CodeSpan.svelte',
          'skeleton',
          'MarkdownImage.svelte',
          'MarkdownLink.svelte',
          'SessionStatusGlyph.svelte',
        ].some((name) => source.endsWith(name))
      ) return COMPONENT_STUB
    },
    load(id) {
      if (id === COMPONENT_STUB) return '<span></span>'
      if (id === OPTIONS_STUB) return 'export const assistantMarkdownOptions = {}'
    },
  }
}

describe('session preview search highlighting', () => {
  let server: ViteDevServer

  beforeAll(async () => {
    server = await createServer({
      configFile: false,
      root: 'packages/workspace-ui',
      optimizeDeps: { noDiscovery: true },
      plugins: [
        previewStubs(),
        svelte({ compilerOptions: { runes: true, dev: false } }),
      ],
      server: { middlewareMode: true },
      appType: 'custom',
      logLevel: 'error',
    })
  })

  afterAll(async () => {
    await server.close()
  })

  it('marks matches in both rendered markdown excerpts', async () => {
    // WHY: a raw-text snippet looks wired in source but SvelteMarkdown bypasses
    // it for ordinary prose. Render the real component so that failure cannot
    // return while title highlighting continues to make the preview look valid.
    const [{ default: SessionPreview }, { render }] = await Promise.all([
      server.ssrLoadModule('/src/components/session/SessionPreview.svelte'),
      server.ssrLoadModule('svelte/server'),
    ])
    const { body } = render(SessionPreview, {
      props: {
        preview: {
          firstUserMessage: {
            role: 'user',
            snippet: 'why does the **open logs** open dev.log',
          },
          lastAssistantMessage: {
            role: 'assistant',
            snippet: 'Use the production logs instead.',
          },
        },
        loading: false,
        title: 'Open Logs',
        query: 'logs',
      },
    })

    expect(body.match(/<mark/g)).toHaveLength(3)
    expect(body).toContain('<strong>')
    expect(body).toContain('>logs</mark>')
  })
})

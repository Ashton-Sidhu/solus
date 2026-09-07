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

  it('shows the hit, marked, and not its neighbours when a row was found by its words', async () => {
    // WHY: a session found by a passage deep in its transcript previewed as
    // its first and last message, with nothing marked — the reader could not
    // see why it was listed. The pane must show the passage, marked, and only
    // the passage: the neighbours the index returned stay out of it.
    const [{ default: SessionPreview }, { render }] = await Promise.all([
      server.ssrLoadModule('/src/components/session/SessionPreview.svelte'),
      server.ssrLoadModule('svelte/server'),
    ])
    const { body } = render(SessionPreview, {
      props: {
        preview: null,
        hitWindow: {
          messages: [
            { role: 'user', passage: 'why is the token gone', isHit: false },
            { role: 'assistant', passage: 'The OAuth token expired at midnight.', isHit: true },
          ],
          hiddenBefore: 12,
          hiddenAfter: 3,
        },
        loading: false,
        title: 'Auth session',
        timeAgo: '2d ago',
        query: 'oauth token',
      },
    })

    expect(body).toContain('>OAuth</mark>')
    expect(body.match(/>token<\/mark>/g)).toHaveLength(1)
    expect(body).not.toContain('why is the token gone')
    // With the ends unknown there is one part, so nothing to divide.
    expect(body).not.toContain('aria-hidden="true"')
  })

  it('reads opening prompt, divider, hit, divider, last reply when the ends are known', async () => {
    // WHY: a passage alone says why the session is listed but not what the
    // conversation was for or where it ended. The pane reads the three parts
    // in transcript order, each under its own rule.
    const [{ default: SessionPreview }, { render }] = await Promise.all([
      server.ssrLoadModule('/src/components/session/SessionPreview.svelte'),
      server.ssrLoadModule('svelte/server'),
    ])
    const { body } = render(SessionPreview, {
      props: {
        preview: {
          firstUserMessage: { role: 'user', snippet: 'why did the login break' },
          lastAssistantMessage: { role: 'assistant', snippet: 'Shipped the fix.' },
        },
        hitWindow: {
          messages: [{ role: 'assistant', passage: 'The OAuth token expired.', isHit: true }],
          hiddenBefore: 5,
          hiddenAfter: 3,
        },
        loading: false,
        title: 'Auth session',
        timeAgo: '2d ago',
        query: 'oauth',
      },
    })
    const order = ['why did the login break', 'aria-hidden="true"', '>OAuth</mark>', 'Shipped the fix.']
    const positions = order.map((needle) => body.indexOf(needle))
    expect(positions.every((position) => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    expect(body.match(/aria-hidden="true"/g)).toHaveLength(2)
  })

  it('divides the opening prompt from the last reply once when there is no hit', async () => {
    const [{ default: SessionPreview }, { render }] = await Promise.all([
      server.ssrLoadModule('/src/components/session/SessionPreview.svelte'),
      server.ssrLoadModule('svelte/server'),
    ])
    const { body } = render(SessionPreview, {
      props: {
        preview: {
          firstUserMessage: { role: 'user', snippet: 'why did the login break' },
          lastAssistantMessage: { role: 'assistant', snippet: 'Shipped the fix.' },
        },
        loading: false,
        title: 'Auth session',
      },
    })
    expect(body.match(/aria-hidden="true"/g)).toHaveLength(1)
  })
})

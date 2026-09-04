import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { createServer, type Plugin, type ViteDevServer } from 'vite'

const CODE_SPAN_STUB = 'virtual:pr-markdown-code-span.svelte'
const ICON_STUB = 'virtual:pr-markdown-icon.svelte'
const LUCIDE_STUB = 'virtual:pr-markdown-lucide.ts'

function prMarkdownStubs(): Plugin {
  return {
    name: 'pr-markdown-test-stubs',
    enforce: 'pre',
    resolveId(source) {
      if (source.endsWith('CodeSpan.svelte')) return CODE_SPAN_STUB
      if (source === '@lucide/svelte') return LUCIDE_STUB
      if (source === ICON_STUB) return ICON_STUB
    },
    load(id) {
      if (id === CODE_SPAN_STUB) return '<code></code>'
      if (id === ICON_STUB) return '<span></span>'
      if (id === LUCIDE_STUB) {
        return [
          'Info',
          'Lightbulb',
          'Sparkle',
          'TriangleAlert',
          'CircleX',
          'Check',
        ].map((name) => `export { default as ${name} } from '${ICON_STUB}'`).join('\n')
      }
    },
  }
}

describe('PR markdown rendering', () => {
  let server: ViteDevServer

  beforeAll(async () => {
    server = await createServer({
      configFile: false,
      root: 'packages/workspace-ui',
      optimizeDeps: { noDiscovery: true },
      plugins: [
        prMarkdownStubs(),
        svelte({ compilerOptions: { runes: true, dev: false } }),
      ],
      server: { middlewareMode: true },
      ssr: { noExternal: ['@lucide/svelte'] },
      appType: 'custom',
      logLevel: 'error',
    })
  })

  afterAll(async () => {
    await server.close()
  })

  it('renders generated GitHub sections while hiding their metadata comments', async () => {
    // WHY: generated PR descriptions and activity comments wrap useful
    // Markdown in invisible HTML markers. GitHub hides the markers and still
    // renders the alert, heading, links, and prose inside them. Our raw-HTML
    // fallback used to print the markers as prose and made the result look like
    // broken Markdown.
    const [
      { default: SvelteMarkdown },
      { githubMarkdownExtensions },
      { githubMarkdownRenderers },
      { remoteMarkdownSanitizeUrl },
      { render },
    ] = await Promise.all([
      server.ssrLoadModule('@humanspeak/svelte-markdown'),
      server.ssrLoadModule('/src/lib/githubMarkdown.ts'),
      server.ssrLoadModule('/src/components/ui/markdown-renderers.ts'),
      server.ssrLoadModule('/src/lib/markdownSanitize.ts'),
      server.ssrLoadModule('svelte/server'),
    ])
    const source = [
      '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
      '',
      '<!-- Macroscope\'s pull request summary starts here -->',
      '> [!NOTE]',
      '> ### Restore focus when `ExpandedImageDialog` closes',
      '> Records the document\'s active element and restores focus on unmount.',
      '>',
      '> <!-- Macroscope\'s review summary starts here -->',
      '> <sup><a href="https://app.macroscope.com">Macroscope</a> summarized f842ddf.</sup>',
      '> <!-- Macroscope\'s review summary ends here -->',
      '<!-- Macroscope\'s pull request summary ends here -->',
    ].join('\n')

    const { body } = render(SvelteMarkdown, {
      props: {
        source,
        extensions: githubMarkdownExtensions,
        renderers: githubMarkdownRenderers,
        sanitizeUrl: remoteMarkdownSanitizeUrl,
      },
    })

    expect(body).not.toContain('pull request summary starts here')
    expect(body).not.toContain('review summary starts here')
    expect(body).toContain('Generated with')
    expect(body).toContain('href="https://claude.com/claude-code"')
    expect(body).toContain('markdown-alert-note')
    expect(body).toContain('>Note</span>')
    expect(body).toContain('<h3')
    expect(body).toContain('Restore focus when')
    expect(body).toContain('<sup>')
    expect(body).toContain('href="https://app.macroscope.com"')
    expect(body).toContain('Macroscope')
  })

  it('keeps unsupported HTML visible as escaped text', async () => {
    // The dependency patch also protects streamed HTML-looking text. The
    // comment exception must stay narrow instead of dropping every HTML token
    // that has no supported tag renderer.
    const [{ default: SvelteMarkdown }, { render }] = await Promise.all([
      server.ssrLoadModule('@humanspeak/svelte-markdown'),
      server.ssrLoadModule('svelte/server'),
    ])

    const { body } = render(SvelteMarkdown, { props: { source: '<agent-status>' } })

    expect(body).toContain('&lt;agent-status>')
  })

  it('renders standalone GitHub videos as provider cards', async () => {
    // WHY: GitHub's only player syntax is a bare uploaded-video URL. Showing
    // that storage address as prose makes before/after recordings hard to scan.
    const [
      { default: SvelteMarkdown },
      { githubMarkdownExtensions },
      { githubMarkdownRenderers },
      { remoteMarkdownSanitizeUrl },
      { render },
    ] = await Promise.all([
      server.ssrLoadModule('@humanspeak/svelte-markdown'),
      server.ssrLoadModule('/src/lib/githubMarkdown.ts'),
      server.ssrLoadModule('/src/components/ui/markdown-renderers.ts'),
      server.ssrLoadModule('/src/lib/markdownSanitize.ts'),
      server.ssrLoadModule('svelte/server'),
    ])
    const url =
      'https://gh-file-drop-api-prod-mi5fy3sowv63ufte.pinglabs.workers.dev/f/4239771dd51fcfde/before-select.mp4'

    const card = render(SvelteMarkdown, {
      props: {
        source: url,
        extensions: githubMarkdownExtensions,
        renderers: githubMarkdownRenderers,
        sanitizeUrl: remoteMarkdownSanitizeUrl,
      },
    }).body
    const imageCard = render(SvelteMarkdown, {
      props: {
        source: `![real t3 code compaction e2e](${url})`,
        extensions: githubMarkdownExtensions,
        renderers: githubMarkdownRenderers,
        sanitizeUrl: remoteMarkdownSanitizeUrl,
      },
    }).body
    const inline = render(SvelteMarkdown, {
      props: {
        source: `See ${url} for the original recording.`,
        extensions: githubMarkdownExtensions,
        renderers: githubMarkdownRenderers,
        sanitizeUrl: remoteMarkdownSanitizeUrl,
      },
    }).body

    expect(card).toContain('Watch on GitHub')
    expect(card).toContain('aria-label="Watch video on GitHub"')
    expect(card).not.toContain(`>${url}<`)
    expect(imageCard).toContain('Watch on GitHub')
    expect(imageCard).toContain('w-full')
    expect(imageCard).not.toContain('max-w-lg')
    expect(imageCard).not.toContain('<img')
    expect(imageCard).not.toContain('real t3 code compaction e2e')
    expect(inline).not.toContain('Watch on GitHub')
    expect(inline).toContain(url)
  })
})

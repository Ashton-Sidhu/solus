import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { createServer, type Plugin, type ViteDevServer } from 'vite'
import { JSDOM } from 'jsdom'

function stubs(): Plugin {
  const names = ['CodeSpan', 'MarkdownLink', 'MarkdownImage']
  return {
    name: 'github-markdown-test-context', enforce: 'pre',
    resolveId(source) {
      if (source === '@lucide/svelte') return 'virtual:markdown-icons'
      if (source === 'virtual:markdown-icon.svelte') return source
      const name = names.find((name) => source.endsWith(`/${name}.svelte`))
      if (name) return `virtual:${name}.svelte`
    },
    load(id) {
      if (id === 'virtual:markdown-icons') return ['Info', 'Lightbulb', 'Sparkle', 'TriangleAlert', 'CircleX', 'Check', 'RotateCw', 'ExternalLink'].map((name) => `export { default as ${name} } from 'virtual:markdown-icon.svelte'`).join('\n')
      if (id === 'virtual:markdown-icon.svelte') return '<span></span>'
      if (id === 'virtual:CodeSpan.svelte') return '<script>let { text } = $props()</script><code>{text}</code>'
      if (id === 'virtual:MarkdownLink.svelte') return '<script>let { href, children } = $props()</script><a {href}>{@render children?.()}</a>'
      if (id === 'virtual:MarkdownImage.svelte') return '<script>let { href, text } = $props()</script><img src={href} alt={text} />'
    },
  }
}

describe('complete GitHub Markdown documents', () => {
  let server: ViteDevServer
  let renderDocument: (source: string, policy?: 'remote' | 'local') => HTMLElement

  beforeAll(async () => {
    server = await createServer({
      configFile: false, root: 'packages/workspace-ui',
      optimizeDeps: { noDiscovery: true },
      plugins: [stubs(), svelte({ compilerOptions: { runes: true, dev: false } })],
      server: { middlewareMode: true }, ssr: { noExternal: ['@lucide/svelte'] },
      appType: 'custom', logLevel: 'error',
    })
    const [{ default: Markdown }, { render }] = await Promise.all([
      server.ssrLoadModule('/src/components/github-markdown/GithubMarkdown.svelte'),
      server.ssrLoadModule('svelte/server'),
    ])
    renderDocument = (source, policy = 'remote') => new JSDOM(render(Markdown, { props: { source, policy } }).body).window.document.body
  })
  afterAll(async () => { await server.close() })

  it('keeps CodeRabbit nested disclosure bodies inside the correct summary controls', () => {
    const source = [
      '> [!CAUTION]', '> Check before merging.', '>',
      '> <details>', '> <summary>Outside diff comments</summary><blockquote>', '>',
      '> <details open>', '> <summary>file.ts</summary><blockquote>', '>',
      '> **Correct the permissions.**', '>',
      '> <details>', '> <summary>Proposed fix</summary>', '>',
      '> ```go', '> type Repository interface {', '>   Find()', '> }', '> ```', '>',
      '> </details>', '>', '> </blockquote></details>', '>', '> </blockquote></details>',
      '', 'After the alert.',
    ].join('\n')
    const body = renderDocument(source)
    const alert = body.querySelector('.markdown-alert-caution')!
    const outer = alert.querySelector('details')!
    const inner = outer.querySelector('details')!
    const fix = inner.querySelector('details')!
    expect(outer.querySelector(':scope > summary')?.textContent).toBe('Outside diff comments')
    expect(inner.querySelector(':scope > summary')?.textContent).toBe('file.ts')
    expect(inner.open).toBe(true)
    expect(outer.open).toBe(false)
    expect(fix.querySelector('pre > code')?.textContent).toContain('  Find()')
    expect(alert.textContent).not.toContain('After the alert.')
    expect(body.textContent).not.toContain('[!CAUTION]')
    // Native disclosure activation must change state in both directions.
    const summary = outer.querySelector('summary')!
    summary.click()
    expect(outer.open).toBe(true)
    summary.click()
    expect(outer.open).toBe(false)
  })

  it('renders alerts inside details, with one code block and literal entities in code', () => {
    const body = renderDocument('<details>\n<summary>More</summary>\n\n> [!NOTE]\n> **Read this.**\n\n```text\n&amp;\n<script>\n```\n\n</details>')
    expect(body.querySelector('details .markdown-alert-note strong')?.textContent).toBe('Read this.')
    expect(body.querySelectorAll('pre > code')).toHaveLength(1)
    expect(body.querySelector('pre code')?.textContent).toBe('&amp;\n<script>\n')
    expect(body.querySelectorAll('script')).toHaveLength(0)
  })

  it('supports all alert kinds but leaves same-line and unknown markers alone', () => {
    for (const kind of ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION']) {
      expect(renderDocument(`> [!${kind}]\n> body`).querySelector(`.markdown-alert-${kind.toLowerCase()}`)).not.toBeNull()
    }
    expect(renderDocument('> [!NOTE] aside').querySelector('.markdown-alert')).toBeNull()
    expect(renderDocument('> [!NOTE]*aside*').querySelector('.markdown-alert')).toBeNull()
    expect(renderDocument('> [!DANGER]\n> body').textContent).toContain('[!DANGER]')
  })

  it('renders tables, task lists, inline code, entities and hidden metadata', () => {
    const body = renderDocument('<!-- generated -->\nA &amp; B with `code`.\n\n| A | B |\n| - | - |\n| one | two |\n\n- [x] Complete\n- [ ] Pending')
    expect(body.textContent).toContain('A & B with code.')
    expect(body.textContent).not.toContain('generated')
    expect(body.querySelectorAll('table tbody td')).toHaveLength(2)
    expect(body.querySelectorAll('.markdown-task-item')).toHaveLength(2)
    expect(body.querySelectorAll('.markdown-task-checked')).toHaveLength(1)
  })

  it('renders a bot task checkbox as the read-only task row and keeps table column alignment', () => {
    // CodeRabbit's retry control: a task item inside an alert, with an HTML
    // comment between the box and its label.
    const body = renderDocument('> [!IMPORTANT]\n> Retry:\n> - [ ] <!-- {"checkboxId":"x"} --> 🔍 Trigger review\n\n| Check | Status |\n| :---: | ---: |\n| Title | ✅ |')
    const task = body.querySelector('.markdown-alert li.markdown-task-item')
    expect(task?.textContent).toContain('Trigger review')
    expect(body.querySelector('input[type="checkbox"]')).toBeNull()
    // The stylesheet reads `align` to centre or right-align a GitHub column.
    expect(body.querySelector('th')?.getAttribute('align')).toBe('center')
    expect(body.querySelector('td:last-child')?.getAttribute('align')).toBe('right')
  })

  it('sets code-host mentions apart but leaves emails, code and links as text', () => {
    // WHY: "@juliusmarminge this should be quick" addresses a person; the
    // mention has to read as one, while an address or a literal must not.
    const body = renderDocument('@juliusmarminge and @org/team, see a@b.com, `@literal` and [@link](https://x.dev)')
    const mentions = [...body.querySelectorAll('.markdown-mention')].map((node) => node.textContent)
    expect(mentions).toEqual(['@juliusmarminge', '@org/team'])
    expect(body.textContent).toContain('see a@b.com,')
    // Task and guide text is not code-host text, so it keeps plain `@`.
    expect(renderDocument('@someone', 'local').querySelector('.markdown-mention')).toBeNull()
  })

  it('removes executable HTML and remote navigation protocols throughout nested content', () => {
    const body = renderDocument('<details onclick="alert(1)"><summary>More</summary>\n\n<script>alert(1)</script>\n\n[bad](javascript:alert) [file](file:///tmp/private) [task](task://id)\n\n<img src="data:image/svg+xml;base64,AAAA" onerror="alert(1)">\n\n<iframe src="https://example.com"></iframe>\n\n</details>')
    expect(body.querySelector('script, iframe, [onclick], [onerror]')).toBeNull()
    expect(body.querySelector('a[href], img[src]')).toBeNull()
  })

  it('keeps local task references and pasted raster images with a narrow policy', () => {
    const body = renderDocument('[task](task://123)\n\n![paste](data:image/png;base64,AAAA)\n\n![bad](data:image/svg+xml;base64,AAAA)\n\n[bad](javascript:alert)', 'local')
    expect(body.querySelector('a')?.getAttribute('href')).toBe('task://123')
    expect(body.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA')
    expect(body.innerHTML).not.toContain('data:image/svg')
    expect(body.innerHTML).not.toContain('javascript:')
  })

  it('plays WebM and M4V links in PR and task bodies without eager downloads', () => {
    for (const policy of ['remote', 'local'] as const) {
      for (const extension of ['webm', 'm4v']) {
        const url = `https://example.com/recording.${extension}?token=123`;
        for (const source of [url, `![Recording](${url})`]) {
          const body = renderDocument(source, policy)
          const video = body.querySelector('video')
          expect(video?.getAttribute('src')).toBe(url)
          expect(video?.getAttribute('preload')).toBe('none')
          expect(video?.hasAttribute('controls')).toBe(true)
          expect(video?.hasAttribute('playsinline')).toBe(true)
          expect(body.querySelector('img')).toBeNull()
        }
        const labelled = renderDocument(`[Download recording](${url})`, policy)
        expect(labelled.querySelector('video')).toBeNull()
        expect(labelled.textContent).toContain('Download recording')
      }
    }
  })

  it('plays standalone videos in place, inside alerts too, and leaves ordinary links as text', () => {
    const url = 'https://github.com/user-attachments/assets/abc'
    const body = renderDocument(`> [!NOTE]\n> ${url}\n\nSee [recording](${url}).`)
    // WHY: a GitHub upload is published as a bare URL; the reader plays it inline,
    // so a reader never leaves the review to watch a recording.
    expect(body.querySelector('.markdown-alert video')?.getAttribute('src')).toBe(url)
    // The link to the host stays beside the player for a reader who wants it.
    expect(body.querySelector('.markdown-alert .markdown-media-link')?.getAttribute('href')).toBe(url)
    expect(body.textContent).toContain('See recording.')
  })
})

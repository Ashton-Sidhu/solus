import { describe, expect, test } from 'bun:test'
import { buildGoogleDocHtml } from '@solus/server/google/document-html'
import { serializeDiagramEmbed } from '@solus/contracts/diagram-embed'

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'

describe('Google document HTML', () => {
  test('replaces diagram references with inline base64 figures', async () => {
    const token = serializeDiagramEmbed({ workId: 'diagram-1', title: 'Fallback' })
    const html = await buildGoogleDocHtml(`# Design\n\n${token}\n\nAfter.`, [{
      workId: 'diagram-1',
      title: 'System Architecture',
      mimeType: 'image/png',
      base64: PNG_BASE64,
    }])

    expect(html).toContain('<h1>Design</h1>')
    expect(html).toContain(`src="data:image/png;base64,${PNG_BASE64}"`)
    expect(html).toContain('<figcaption>System Architecture</figcaption>')
    expect(html).toContain('<p>After.</p>')
    expect(html).not.toContain('work://embed')
  })

  test('does not pass raw HTML or unsafe links to Drive', async () => {
    const html = await buildGoogleDocHtml('<script>alert(1)</script>\n\n[bad](javascript:alert(1))', [])
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('javascript:')
  })

  test('fails when an embed has no prepared image', async () => {
    const token = serializeDiagramEmbed({ workId: 'missing', title: 'Missing' })
    expect(buildGoogleDocHtml(token, [])).rejects.toThrow('was not prepared')
  })
})

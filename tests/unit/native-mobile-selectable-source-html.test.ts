import { describe, expect, test } from 'bun:test'
import { selectableSourceHtml, selectableSourceScript } from '../../apps/mobile/src/features/files/lib/selectable-source-html'

const style = { foreground: '#000000', selection: '#3366ff', fontSize: 14, rowHeight: 24, wordBreak: true }

function body(html: string): string {
  return html.slice(html.indexOf('<body><div>') + '<body><div>'.length, html.lastIndexOf('</div></body>'))
}

describe('native selectable source page', () => {
  test('shows file markup as literal text, never as page markup', () => {
    // WHY: the file is untrusted text; a `<script>` or a quote in it must not
    // become page content when the person selects it on Android.
    const html = selectableSourceHtml(`<script>alert("x")</script> & 'q' > end`, style)
    expect(html).not.toContain('<script>')
    expect(body(html)).toBe(
      '<span id="L1">&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39; &gt; end</span>',
    )
  })

  test('keeps every whitespace character and gives each line an id', () => {
    // WHY: copied text must paste exactly as the file, and the page scrolls to
    // the pressed line by its id.
    const html = selectableSourceHtml('\n\tlead  x\r\n  end\n', style)
    expect(body(html)).toBe('<span id="L1"></span>\n<span id="L2">\tlead  x</span>\n<span id="L3">  end</span>\n<span id="L4"></span>')
    expect(html).toContain('white-space:pre-wrap')
    expect(selectableSourceHtml('a', { ...style, wordBreak: false })).toContain('white-space:pre;')
  })

  test('copies plain text and scrolls to the pressed line', () => {
    const script = selectableSourceScript(12)
    expect(script).toContain('setData("text/plain"')
    expect(script).toContain('getElementById("L12")')
  })
})

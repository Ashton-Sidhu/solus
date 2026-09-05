import { describe, expect, test } from 'bun:test'
import { Marked } from 'marked'
import {
  RAW_HTML_TOKEN,
  rawHtmlMarkedExtension,
  rawHtmlRun,
} from '../../packages/workspace-ui/src/components/conversation/lib/raw-html'

describe('raw HTML written straight into a reply', () => {
  test('a stylesheet and the markup it styles are one render', () => {
    // WHY: they are two top-level elements. Taking only the first would hand
    // the frame a stylesheet with nothing to style and leave the markup in the
    // host DOM stripped of it — which is exactly today's broken render.
    const src = '<style>.card{color:red}</style>\n\n<div class="card">Hi</div>\n\nAfter.'
    const run = rawHtmlRun(src)

    expect(run?.html).toBe('<style>.card{color:red}</style>\n\n<div class="card">Hi</div>')
    expect(src.slice(run!.raw.length).trim()).toBe('After.')
  })

  test('plain markup is left to the markdown library and its prose styles', () => {
    // WHY: a table put in a frame loses the app's typography and cannot be
    // selected with the prose around it. Only markup that brings its own look
    // needs the frame.
    expect(rawHtmlRun('<table><tr><td>1</td></tr></table>\n')).toBeNull()
    expect(rawHtmlRun('<details><summary>More</summary>body</details>\n')).toBeNull()
    expect(rawHtmlRun('Just a sentence.\n')).toBeNull()
  })

  test('a whole document is one run', () => {
    const src = '<!doctype html>\n<html><body><style>b{color:red}</style><b>x</b></body></html>\n'
    expect(rawHtmlRun(src)?.html).toBe(src.trim())
  })

  test('an element that is not closed yet is left alone', () => {
    // WHY: while a reply streams, every element is unclosed for a while.
    // Claiming a partial run would rebuild a frame on every token.
    expect(rawHtmlRun('<div><style>b{color:red}</style>')).toBeNull()
  })

  test('a `>` inside an attribute does not end the tag', () => {
    const run = rawHtmlRun('<div title="a > b"><style>b{color:red}</style></div>\n')
    expect(run?.html).toBe('<div title="a > b"><style>b{color:red}</style></div>')
  })

  test('markup inside a script or a style opens nothing', () => {
    // WHY: `</div>` in a string inside a script is text. Counting it would end
    // the run at the wrong place and cut the render in half.
    const src = '<div><script>document.write("<div>x</div>")</script></div>\n'
    expect(rawHtmlRun(src)?.html).toBe(src.trim())
  })

  test('nesting of the same tag is counted', () => {
    const src = '<div><style>b{color:red}</style><div>inner</div></div>\ntail'
    const run = rawHtmlRun(src)
    expect(run?.html).toBe('<div><style>b{color:red}</style><div>inner</div></div>')
  })

  test('a self-closing element does not wait for a closing tag', () => {
    const src = '<svg viewBox="0 0 8 8"><circle r="4" /></svg>\n'
    expect(rawHtmlRun(src)?.html).toBe(src.trim())
  })
})

describe('the run reaches the renderer as one token', () => {
  test('marked hands it over before its own block-html rule sees it', () => {
    // WHY: block-level extension tokenizers run before every built-in one.
    // That ordering is the whole mechanism; without it marked splits the run
    // into one token per blank-line-delimited chunk.
    const marked = new Marked(rawHtmlMarkedExtension)
    const tokens = marked.lexer('Before.\n\n<style>b{color:red}</style>\n\n<b>x</b>\n\nAfter.')

    const types = tokens.map((token) => token.type)
    expect(types).toEqual(['paragraph', 'space', RAW_HTML_TOKEN, 'paragraph'])
    expect((tokens[2] as unknown as { html: string }).html).toContain('<style>')
    expect((tokens[2] as unknown as { html: string }).html).toContain('<b>x</b>')
  })

  test('a plain table still lexes as ordinary html', () => {
    const marked = new Marked(rawHtmlMarkedExtension)
    const tokens = marked.lexer('<table><tr><td>1</td></tr></table>\n')
    expect(tokens.map((token) => token.type)).not.toContain(RAW_HTML_TOKEN)
  })

  test('a fenced html block is still a code token', () => {
    // WHY: the fence path and the raw path must not both claim the same
    // source, or a snippet the agent meant to be read would render.
    const marked = new Marked(rawHtmlMarkedExtension)
    const tokens = marked.lexer('```html\n<style>b{color:red}</style>\n```\n')
    expect(tokens.map((token) => token.type)).toEqual(['code'])
  })
})

test('longer tag names inside raw text do not close the render', () => {
  const html = '<script>const closingTag = "</script-template>";</SCRIPT ><div>Output</div>'
  expect(rawHtmlRun(html)?.html).toBe(html)
  const style = '<style>p::before{content:"</stylesheet>"}</style><p>Text</p>'
  expect(rawHtmlRun(style)?.html).toBe(style)
})

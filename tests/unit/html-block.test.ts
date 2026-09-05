import { describe, expect, test } from 'bun:test'
import {
  fenceIsSettled,
  fenceLanguage,
  fenceRenderMode,
  isHtmlFence,
} from '../../packages/workspace-ui/src/components/conversation/lib/html-block'

describe('what an html fence is', () => {
  test('a bare fragment is code to read, not a page to view', () => {
    // WHY: an agent explaining a template bug pastes a `<div>` to be read.
    // Rendering it would show an empty frame where the code was.
    expect(fenceRenderMode('html', '<div class="row">one</div>')).toBe('snippet')
    expect(fenceRenderMode('html', '<table><tr><td>1</td></tr></table>')).toBe('snippet')
  })

  test('a fragment that carries its own styles or behaviour is a page to view', () => {
    expect(fenceRenderMode('html', '<style>b{color:red}</style><b>hi</b>')).toBe('block')
    expect(fenceRenderMode('html', '<div id="a"></div><script>draw()</script>')).toBe('block')
    expect(fenceRenderMode('html', '<!doctype html><html><body>x</body></html>')).toBe('block')
  })

  test('the info string overrides the content test in either direction', () => {
    // WHY: the content test is a good default and a bad absolute. These two
    // words are how the agent says which it meant when the test gets it wrong.
    expect(fenceRenderMode('html render', '<div>plain</div>')).toBe('block')
    expect(fenceRenderMode('html source', '<style>b{color:red}</style>')).toBe('snippet')
    expect(fenceRenderMode('html RENDER', '<div>plain</div>')).toBe('block')
  })

  test('the language is the first word, so a directive never reaches a highlighter', () => {
    expect(fenceLanguage('html render')).toBe('html')
    expect(fenceLanguage('  html   source ')).toBe('html')
    expect(fenceLanguage(undefined)).toBe('')
    expect(isHtmlFence('html render')).toBe(true)
    expect(isHtmlFence('htmlx')).toBe(false)
    expect(isHtmlFence('ts')).toBe(false)
  })
})

describe('a fence that is still being written', () => {
  test('an open fence is not settled, a closed one is', () => {
    // WHY: while a message streams, a growing fence must render as source.
    // Swapping to a frame per token would rebuild an iframe at the rate the
    // model writes, and the reader would watch a page flicker into existence.
    expect(fenceIsSettled('```html\n<style>b{color:red}</style>\n')).toBe(false)
    expect(fenceIsSettled('```html\n<style>b{color:red}</style>\n```\n')).toBe(true)
    expect(fenceIsSettled('```html\n<div>x</div>\n```')).toBe(true)
    expect(fenceIsSettled('```html\n')).toBe(false)
    expect(fenceIsSettled('```')).toBe(false)
    expect(fenceIsSettled(undefined)).toBe(false)
  })

  test('the closing delimiter must be at least as wide as the opening one', () => {
    // WHY: an html fence holding markdown examples is opened with four
    // backticks precisely so a three-backtick line inside it is content.
    expect(fenceIsSettled('````html\n```\n')).toBe(false)
    expect(fenceIsSettled('````html\n```\n````\n')).toBe(true)
  })

  test('tildes close tildes, and an indented block has nothing to wait for', () => {
    expect(fenceIsSettled('~~~html\n<div>x</div>\n')).toBe(false)
    expect(fenceIsSettled('~~~html\n<div>x</div>\n~~~\n')).toBe(true)
    expect(fenceIsSettled('    <div>x</div>\n')).toBe(true)
  })
})

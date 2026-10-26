import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Plan: docs/plans/unified-prose.md. Solus had seven prose rulesets, and each
// surface's copy drifted: different heading sizes, bullets, code, and links for
// the same markdown. `prose.css` is now the one style. This guards the reason
// it exists: no other stylesheet rule may set the type of a prose element.

const SRC = join(import.meta.dir, '../../packages/workspace-ui/src')
const workspaceCss = readFileSync(join(SRC, 'workspace.css'), 'utf8')
const proseCss = readFileSync(join(SRC, 'prose.css'), 'utf8')

/** Hosts a prose column renders in. */
const PROSE_HOST = /\.(?:prose\b|ProseMirror\b|solus-doc-editor\b|doc-shell-root\b|doc-prompt-editor\b)/
/** A prose element as the selector's subject (not a pseudo-element on it). */
const PROSE_SUBJECT = /(?:^|[\s>+~(,])(?:p|h[1-6]|ul|ol|li|blockquote|pre|code|table|th|td|hr|strong|em|a)(?:[.:[][^\s>+~]*)?\s*$/
/** The properties that make up a prose style. */
const TYPE_PROPERTY = /(?:^|;|\{)\s*(?:font-size|font-weight|font-family|line-height|color|margin(?:-[a-z-]+)?|list-style(?:-type)?|text-decoration)\s*:/

/** Every rule as its selector list and body, with comments removed. */
function rules(css: string): Array<{ selectors: string[]; body: string }> {
  const uncommented = css.replace(/\/\*[\s\S]*?\*\//g, '')
  return [...uncommented.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
    selectors: selector.split(',').map((part) => part.trim()).filter(Boolean),
    body,
  }))
}

describe('the one prose style', () => {
  test('no workspace rule outside prose.css sets the type of a prose element', () => {
    const offenders = rules(workspaceCss).flatMap(({ selectors, body }) =>
      selectors
        .filter((selector) => PROSE_HOST.test(selector) && PROSE_SUBJECT.test(selector) && !selector.includes('::'))
        // Bold inline code takes the bold treatment; it restates nothing.
        .filter((selector) => selector !== '.prose strong > code')
        .filter(() => TYPE_PROPERTY.test(body)),
    )
    expect(offenders).toEqual([])
  })

  test('the guard sees a prose rule when one is written', () => {
    // WHY: a pattern that matches nothing passes forever. Prove the scan reads
    // a rule of the shape it is meant to reject.
    const planted = rules('.doc-shell-root .solus-doc-editor .ProseMirror h2 { font-size: 25px; }')
    expect(planted.some(({ selectors, body }) =>
      selectors.some((selector) => PROSE_HOST.test(selector) && PROSE_SUBJECT.test(selector)) && TYPE_PROPERTY.test(body),
    )).toBe(true)
  })

  test('prose.css is in the components layer, so a utility can still win', () => {
    expect(proseCss.replace(/\/\*[\s\S]*?\*\//g, '').trim().startsWith('@layer components {')).toBe(true)
    expect(workspaceCss).toContain('@import "./prose.css";')
  })
})

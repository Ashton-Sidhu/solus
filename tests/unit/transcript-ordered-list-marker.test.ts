import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const css = readFileSync(
  new URL('../../packages/workspace-ui/src/index.css', import.meta.url),
  'utf8',
)

const transcriptLists = css.slice(
  css.indexOf('.prose-transcript ul,'),
  css.indexOf('.prose-transcript li > input[type="checkbox"] {'),
)

describe('assistant message ordered list markers', () => {
  test('numerals are native markers, so the browser owns their position', () => {
    // WHY: a hand-drawn ::before numeral has to reproduce baseline alignment and
    // end-alignment of the marker box by hand, and gets both wrong the moment
    // the marker font size differs from the body text — which is exactly the
    // quiet mono treatment this list wants. Native markers make it free.
    expect(transcriptLists).toContain('list-style: decimal')
    expect(transcriptLists).toMatch(/\.prose-transcript ol > li::marker \{/)
    expect(transcriptLists).not.toContain('counter-increment')
    expect(transcriptLists).not.toMatch(/\.prose-transcript ol > li::before/)
  })

  test('the ::marker rule sets appearance only, never position', () => {
    // WHY: ::marker accepts font and colour; anything positional here is a sign
    // the drawn-marker approach is creeping back in.
    const markerRule = transcriptLists.match(
      /\.prose-transcript ol > li::marker \{[\s\S]*?\}/,
    )?.[0]

    expect(markerRule).toBeTruthy()
    expect(markerRule).toContain('font-variant-numeric: tabular-nums')
    expect(markerRule).toContain('color: var(--solus-text-tertiary)')
    expect(markerRule).not.toMatch(/position|left|width|text-align|line-height/)
  })

  test('a task item keeps its checkbox instead of a marker', () => {
    // WHY: dropping the drawn ::before is no longer enough — a checklist inside
    // an ordered list would otherwise show a numeral and a checkbox.
    expect(transcriptLists).toContain(
      '.prose-transcript li:has(> input[type="checkbox"]) { list-style: none; }',
    )
  })
})

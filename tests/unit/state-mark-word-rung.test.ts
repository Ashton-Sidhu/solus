import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const glyph = readFileSync('packages/workspace-ui/src/components/session/TaskStatusGlyph.svelte', 'utf8')

test('a state mark drops its word on a narrow container and keeps its glyph and sentence', () => {
  // WHY: Input, Approval, and Limited name themselves only where the row has
  // room; below the rung the title needs the width. The glyph must hold at
  // every width, and the full sentence must stay in the label, so a narrow
  // sidebar loses no state.
  const wordRungs = [...glyph.matchAll(/@max-\[(\d+)rem\]:hidden" aria-hidden="true">\{(word|resetClock)\}/g)]
  expect(wordRungs.map((m) => m[2])).toEqual(['word', 'resetClock'])
  expect(new Set(wordRungs.map((m) => m[1]))).toEqual(new Set(['18']))
  expect(glyph).toMatch(/<Glyph \{size\} strokeWidth=\{2\.25\} \/>/)
  expect(glyph).not.toMatch(/<Glyph[^>]*hidden/)
  expect(glyph).toContain('aria-label={label}')
})

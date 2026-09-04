import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const CSS = readFileSync(
  new URL('../../packages/workspace-ui/src/index.css', import.meta.url),
  'utf8',
)

const rule = (selector: string) => {
  const start = CSS.indexOf(selector)
  expect(start).toBeGreaterThan(-1)
  return CSS.slice(start, CSS.indexOf('}', start) + 1)
}

const laptopTypeBlock = () => {
  const start = CSS.indexOf('html.is-laptop-display {')
  expect(start).toBeGreaterThan(-1)
  return CSS.slice(start, CSS.indexOf('}', start) + 1)
}

describe('task and pull request prose typography', () => {
  test('task and PR descriptions and activity comments use one reading rung', () => {
    // WHY: task and PR descriptions are the same kind of reading content and
    // must not drift to different sizes.
    expect(rule('.prose-pr,')).toContain('--prose-pr-size: var(--text-description-prose)')
    expect(rule('.prose-pr-activity {')).toContain('--prose-pr-size: var(--text-description-prose)')
  })

  test('description and compact PR rungs step down on precise-pointer laptop displays', () => {
    // WHY: the larger type must remain responsive in the dense laptop layout,
    // without reducing touch clients that use the base values.
    const laptop = laptopTypeBlock()
    expect(CSS).toContain('--text-description-prose: calc(1rem * var(--solus-font-scale, 1))')
    expect(CSS).toContain('--text-pr-prose-compact: calc(0.875rem * var(--solus-font-scale, 1))')
    expect(laptop).toContain('--text-description-prose: calc(0.875rem * var(--solus-font-scale, 1))')
    expect(laptop).toContain('--text-pr-prose-compact: calc(0.75rem * var(--solus-font-scale, 1))')
  })
})

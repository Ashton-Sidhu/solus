import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(
  fileURLToPath(
    new URL(
      '../../packages/workspace-ui/src/components/conversation/QuestionCard.svelte',
      import.meta.url,
    ),
  ),
  'utf8',
)

const fieldStart = source.indexOf('<Textarea')
const answerField = source.slice(fieldStart, source.indexOf('/>', fieldStart))

describe('question card answer field', () => {
  // Without a cap the field grows with the answer — `field-sizing: content` has
  // no limit of its own — and pushes Send answer out of the viewport.
  test('caps how far a long answer can grow the field', () => {
    expect(answerField).toContain('max-h-[7.5rem]')
  })

  // The mic overlays the field, so its strip must be margin: padding would keep
  // the strip inside the field's box and draw the scroll thumb over the words
  // and under the mic once the answer is long enough to scroll.
  test('reserves the mic strip outside the scrolling box', () => {
    expect(answerField).toContain('mr-8')
    expect(answerField).not.toContain('pr-8')
  })
})

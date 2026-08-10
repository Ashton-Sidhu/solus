import { describe, expect, test } from 'bun:test'
import type { Prompt } from '../../src/shared/types'
import { draftTitle } from '../../src/renderer/components/session/lib/draft-list'

function promptWith(fields: Partial<Prompt>): Prompt {
  return {
    text: '',
    attachments: [],
    planRefs: [],
    workRefs: [],
    sessionRefs: [],
    savedPromptId: null,
    ...fields,
  } as Prompt
}

describe('naming a draft in the sidebar', () => {
  test('is named by the first thing written in it', () => {
    const title = draftTitle(promptWith({ text: '\n\n  Rework the migration runner  \nthen the tests' }))

    // WHY: nothing else names a draft — it has no session, no task record and no
    // title the user set — so the row has to read as the prompt does when you
    // say out loud which draft you mean.
    expect(title).toBe('Rework the migration runner')
  })

  test('collapses the whitespace a pasted prompt carries', () => {
    // WHY: a row is one line. Tabs and runs of spaces survive a paste and would
    // otherwise push the readable part of the title out of the column.
    expect(draftTitle(promptWith({ text: 'Fix\tthe   flaky  test' }))).toBe('Fix the flaky test')
  })

  test('caps a pasted essay rather than putting it all in the row', () => {
    const title = draftTitle(promptWith({ text: 'x'.repeat(400) }))

    // WHY: the row truncates in CSS, but the string also reaches the DOM and the
    // tooltip. A whole pasted document in both is paid for on every render.
    expect(title.length).toBeLessThanOrEqual(161)
    expect(title.endsWith('…')).toBe(true)
  })

  test('a draft of files alone says so', () => {
    const files = draftTitle(promptWith({
      text: '   ',
      attachments: [{ id: 'a' }, { id: 'b' }] as never,
    }))

    // WHY: attachments make a draft worth keeping on their own, so it earns a
    // row — and a blank title on that row would read as a bug.
    expect(files).toBe('2 attachments')
  })
})

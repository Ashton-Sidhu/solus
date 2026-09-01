import { describe, expect, test } from 'bun:test'
import { questionAnchorScrollTop } from '@solus/workspace-ui/components/conversation/lib/question-scroll'

describe('conversation question scroll anchoring', () => {
  test('keeps preceding turn context visible above a newly mounted question', () => {
    expect(questionAnchorScrollTop(900, 500, 600)).toBe(1250)
  })

  test('caps the retained context so large viewports still reveal the question', () => {
    expect(questionAnchorScrollTop(900, 700, 1000)).toBe(1440)
  })

  test('does not scroll before the start of a short conversation', () => {
    expect(questionAnchorScrollTop(0, 80, 600)).toBe(0)
  })
})

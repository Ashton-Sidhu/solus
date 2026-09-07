import { describe, test, expect } from 'bun:test'
import { shouldFocusReadyComposer } from '../../packages/workspace-ui/src/components/input/lib/connection-focus'

describe('focus when a session connection completes', () => {
  test('restores typing when the active composer becomes ready and focus is on the page', () => {
    expect(shouldFocusReadyComposer(true, { tagName: 'BODY', isContentEditable: false })).toBe(true)
  })
  test('keeps focus in a field the user entered while waiting', () => {
    for (const tagName of ['INPUT', 'TEXTAREA']) {
      expect(shouldFocusReadyComposer(true, { tagName, isContentEditable: false })).toBe(false)
    }
    expect(shouldFocusReadyComposer(true, { tagName: 'DIV', isContentEditable: true })).toBe(false)
  })
  test('does not take focus from another pane', () => {
    expect(shouldFocusReadyComposer(false, { tagName: 'BODY', isContentEditable: false })).toBe(false)
  })
})

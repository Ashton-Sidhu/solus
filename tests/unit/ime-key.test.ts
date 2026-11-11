import { describe, expect, test } from 'bun:test'
import { isImeKey } from '@solus/workspace-ui/lib/ime'

function enter(composition: { isComposing: boolean; keyCode: number }) {
  return { key: 'Enter', ...composition } as KeyboardEvent
}

describe('isImeKey', () => {
  // WHY: search overlays and the command palette open the selected row on
  // Enter and move it on arrow keys. The same keys commit or move inside an
  // IME composition, so they must stay in the input while it composes.
  test('an Enter inside a composition is an IME key', () => {
    expect(isImeKey(enter({ isComposing: true, keyCode: 13 }))).toBe(true)
  })

  test('keyCode 229 is an IME key when isComposing is false (Safari)', () => {
    expect(isImeKey(enter({ isComposing: false, keyCode: 229 }))).toBe(true)
  })

  test('a plain Enter is not an IME key', () => {
    expect(isImeKey(enter({ isComposing: false, keyCode: 13 }))).toBe(false)
  })
})

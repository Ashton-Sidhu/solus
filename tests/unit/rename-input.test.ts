import { describe, expect, it } from 'bun:test'
import {
  committedRenameValue,
  focusRenameInputText,
} from '../../src/renderer/lib/rename-input'

describe('focusRenameInputText', () => {
  it('owns focus and selects the current title for replacement', () => {
    let focused = false
    let selected = false
    const target = {
      scrollLeft: 120,
      focus() {
        focused = true
      },
      select() {
        selected = true
      },
    }

    focusRenameInputText(target)

    expect(focused).toBe(true)
    expect(selected).toBe(true)
    expect(target.scrollLeft).toBe(0)
  })
})

describe('committedRenameValue', () => {
  it('never emits an empty task or session title', () => {
    expect(committedRenameValue('', 'Existing title')).toBeNull()
    expect(committedRenameValue('   ', 'Existing title')).toBeNull()
  })

  it('trims and emits a changed title', () => {
    expect(committedRenameValue('  New title  ', 'Existing title')).toBe('New title')
  })
})

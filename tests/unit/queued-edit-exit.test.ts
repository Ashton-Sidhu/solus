import { describe, expect, it } from 'bun:test'
import { queuedEditExit } from '@solus/workspace-ui/components/conversation/queued/lib/queued-edit-exit'

// A queue edit whose entry starts (or another client removes it) must not lose
// what the user typed in silence, and must not raise a notice for nothing.
describe('queuedEditExit', () => {
  it('keeps a removed attachment as an edit when the text is unchanged', () => {
    expect(queuedEditExit({ changed: true, text: 'Original message', composerDraftEmpty: true })).toBe('kept')
  })

  it('discards an attachment-only edit that has no text to put back', () => {
    expect(queuedEditExit({ changed: true, text: '  ', composerDraftEmpty: true })).toBe('discarded')
  })

  it('does not overwrite a composer draft the user already started', () => {
    expect(queuedEditExit({ changed: true, text: 'Edited', composerDraftEmpty: false })).toBe('discarded')
  })

  it('closes an unchanged edit with no notice', () => {
    expect(queuedEditExit({ changed: false, text: 'Original message', composerDraftEmpty: true })).toBe('clean')
  })
})

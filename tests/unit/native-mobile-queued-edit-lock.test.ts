// T3 Code #21390: lock the composer while a queued-message edit saves.
import { describe, expect, mock, test } from 'bun:test'

mock.module('react-native', () => ({ Alert: { alert: () => undefined } }))

const { composerDraftView } = await import('../../apps/mobile/src/features/threads/use-composer-queued-edit')
type QueuedEditView = NonNullable<Parameters<typeof composerDraftView>[0]>

function queuedEdit(saving: boolean, typed: string[]): QueuedEditView {
  return {
    saving,
    text: 'fix the test',
    attachments: [],
    hasContent: true,
    attachmentsFull: false,
    setText: (text) => typed.push(text),
    removeAttachment: () => undefined,
    attach: async () => undefined,
    save: async () => undefined,
  }
}

const conversation = { text: '', onChangeText: () => undefined, attachments: [], uploading: 0 }

describe('native composer queued edit lock', () => {
  test('typing while the edit saves is dropped, because the save sends a snapshot and ends the edit', () => {
    const typed: string[] = []
    const view = composerDraftView(queuedEdit(true, typed), conversation)
    expect(view.locked).toBe(true)
    view.onChangeText('fix the test and the lint')
    expect(typed).toEqual([])
  })

  test('an edit that is not saving, and the conversation draft, accept typing', () => {
    const typed: string[] = []
    const view = composerDraftView(queuedEdit(false, typed), conversation)
    expect(view.locked).toBe(false)
    view.onChangeText('fix the test and the lint')
    expect(typed).toEqual(['fix the test and the lint'])
    expect(composerDraftView(null, conversation).locked).toBe(false)
  })
})

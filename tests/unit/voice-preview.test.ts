import { expect, test } from 'bun:test'
import { EditorState, type Extension } from '@codemirror/state'
import type { VoicePartial } from '@solus/contracts/voice-stream'
import { dictationInsertion } from '@solus/workspace-ui/components/input/lib/dictation-text'
import { setVoicePreview, voicePreview } from '@solus/workspace-ui/components/ui/plain-text-editor/lib/voice-preview'
import { JSDOM } from 'jsdom'
import type { WidgetType } from '@codemirror/view'

function stateWith(doc: string, anchor: number, head = anchor, extensions: Extension[] = [voicePreview]) {
  return EditorState.create({ doc, selection: { anchor, head }, extensions })
}

function preview(state: EditorState) {
  const found: { at: number; stable: string; tentative: string }[] = []
  state.field(voicePreview).between(0, state.doc.length, (at, _to, decoration) => {
    const { stable, tentative } = decoration.spec.widget
    found.push({ at, stable, tentative })
  })
  return found
}

const speak = (state: EditorState, partial: VoicePartial | null) =>
  state.update({ effects: setVoicePreview.of(partial) }).state

test('live words sit at the caret without entering the draft', () => {
  // WHY: the draft stays the user's until the transcript lands. A preview in the
  // document would reach the value the composer saves and sends.
  const state = speak(stateWith('Fix the bug', 11), { stable: 'in the ', tentative: 'parser' })
  expect(state.doc.toString()).toBe('Fix the bug')
  expect(preview(state)).toEqual([{ at: 11, stable: ' in the ', tentative: 'parser' }])
})

test('the preview shows the text the transcript will insert', () => {
  // WHY: a mismatch shifts words when the final transcript replaces the preview.
  const doc = 'Fix bug now'
  const state = speak(stateWith(doc, 3), { stable: 'the ', tentative: 'parser' })
  const [{ stable, tentative }] = preview(state)
  expect(stable + tentative).toBe(dictationInsertion('the parser', 'Fix', ' bug now'))
  const wedged = speak(stateWith('Fixbug', 3), { stable: '', tentative: 'the' })
  const [word] = preview(wedged)
  expect(word.stable + word.tentative).toBe(dictationInsertion('the', 'Fix', 'bug'))
})

test('a selection the transcript will replace puts the words at its end', () => {
  const state = speak(stateWith('Fix the bug', 4, 7), { stable: 'a ', tentative: '' })
  expect(preview(state).map((entry) => entry.at)).toEqual([7])
})

test('silence and cancel draw nothing', () => {
  // WHY: the recorder resets to empty text, and a stale widget would stay on
  // screen after Cancel.
  const spoken = speak(stateWith('', 0), { stable: 'hello', tentative: '' })
  expect(preview(spoken)).toHaveLength(1)
  expect(preview(speak(spoken, { stable: '', tentative: '' }))).toEqual([])
  expect(preview(speak(spoken, null))).toEqual([])
})

test('a revised tentative word replaces the previous one', () => {
  const first = speak(stateWith('', 0), { stable: 'Open the ', tentative: 'cat' })
  const second = speak(first, { stable: 'Open the ', tentative: 'calendar' })
  expect(preview(second)).toEqual([{ at: 0, stable: 'Open the ', tentative: 'calendar' }])
})

test('text updates retain confirmed and tentative nodes, including empty words', () => {
  const dom = new JSDOM()
  const originalDocument = globalThis.document
  const originalText = globalThis.Text
  globalThis.document = dom.window.document
  globalThis.Text = dom.window.Text
  const widget = (partial: VoicePartial): WidgetType => {
    const decoration = speak(stateWith('', 0), partial).field(voicePreview).iter().value
    if (!decoration) throw new Error('Expected live words')
    return decoration.spec.widget
  }
  try {
    const first = widget({ stable: '', tentative: 'Open the cat' })
    const host = first.toDOM(null!)
    const confirmed = host.firstChild
    const ending = host.lastChild
    const tentative = ending?.firstChild
    const revised = widget({ stable: '', tentative: 'Open the calendar' })
    expect(revised.updateDOM(host, null!)).toBe(true)
    expect(host.textContent).toBe('Open the calendar')
    const committed = widget({ stable: 'Open the calendar', tentative: '' })
    expect(committed.updateDOM(host, null!)).toBe(true)
    expect(host.textContent).toBe('Open the calendar')
    const continued = widget({ stable: 'Open the calendar ', tentative: 'tomorrow' })
    expect(continued.updateDOM(host, null!)).toBe(true)
    expect(host.textContent).toBe('Open the calendar tomorrow')
    expect(host.firstChild).toBe(confirmed)
    expect(host.lastChild).toBe(ending)
    expect(host.lastChild?.firstChild).toBe(tentative)
    expect(confirmed?.textContent).toBe('Open the calendar ')
  } finally {
    globalThis.document = originalDocument
    globalThis.Text = originalText
    dom.window.close()
  }
})

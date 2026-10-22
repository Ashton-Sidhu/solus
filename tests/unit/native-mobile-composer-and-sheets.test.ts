import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  composerUsesCard,
  measuredDraftText,
  ONE_ROW_MEASURE_LIMIT,
  oneRowEditorHeight,
  oneRowMeasureFrame,
  oneRowVerdict,
} from '../../apps/mobile/src/features/threads/composer-layout'
import { KeyboardResumeGuard } from '../../apps/mobile/src/features/threads/android-keyboard-resume'

const mobile = join(import.meta.dir, '../../apps/mobile')
const read = (path: string) => readFileSync(join(mobile, path), 'utf8')

const editing = { editing: true, hasEditingAttachments: false, rowMeasured: true, fitsOneRow: true }

describe('compact-until-wrap composer rules (T3 #20812)', () => {
  test('focus alone keeps the one-row capsule; the card is for a draft that does not fit one line', () => {
    expect(composerUsesCard({ ...editing, text: '' })).toBe(false)
    expect(composerUsesCard({ ...editing, text: 'fix the test' })).toBe(false)
    expect(composerUsesCard({ ...editing, text: 'a draft the text engine wrapped', fitsOneRow: false })).toBe(true)
  })

  test('an unfocused composer is always the capsule, whatever the draft', () => {
    expect(composerUsesCard({ ...editing, editing: false, text: 'one\ntwo', fitsOneRow: false, hasEditingAttachments: true })).toBe(false)
  })

  test('a line break is its own line, also a trailing one that iOS line fragments do not count', () => {
    for (const text of ['one\ntwo', 'trailing\n', 'windows\r\n', 'separator\u2028', 'paragraph\u2029']) {
      expect(composerUsesCard({ ...editing, text })).toBe(true)
    }
  })

  test('a cleared draft returns to the row, even before the hidden copy is laid out again', () => {
    expect(composerUsesCard({ ...editing, text: '', fitsOneRow: false })).toBe(false)
  })

  test('removable attachments use the card, where their strip is', () => {
    expect(composerUsesCard({ ...editing, text: '', hasEditingAttachments: true })).toBe(true)
  })

  test('a draft longer than the measured prefix is the card without laying it all out', () => {
    expect(composerUsesCard({ ...editing, text: 'x'.repeat(ONE_ROW_MEASURE_LIMIT + 1) })).toBe(true)
    expect(composerUsesCard({ ...editing, text: 'x'.repeat(ONE_ROW_MEASURE_LIMIT) })).toBe(false)
    expect(measuredDraftText('x'.repeat(ONE_ROW_MEASURE_LIMIT + 5)).length).toBe(ONE_ROW_MEASURE_LIMIT)
  })

  test('until the row chrome is measured, a wrapping verdict cannot hold the card: the row shows to be measured', () => {
    expect(composerUsesCard({ ...editing, text: 'long draft', rowMeasured: false, fitsOneRow: false })).toBe(false)
  })

  test('a text layout counts only for the draft it measured', () => {
    expect(oneRowVerdict('hello world', [{ text: 'hello world' }])).toBe(true)
    expect(oneRowVerdict('hello world', [{ text: 'hello ' }, { text: 'world' }])).toBe(false)
    expect(oneRowVerdict('hello world!', [{ text: 'hello ' }, { text: 'world' }])).toBeNull()
    expect(oneRowVerdict('', [])).toBe(true)
  })

  test('the row keeps the 36-point pill and grows for one full line at large text sizes', () => {
    expect(oneRowEditorHeight(23)).toBe(36)
    expect(oneRowEditorHeight(41.5)).toBe(42)
  })
})

/**
 * A model of the protocol between ThreadComposer and Fabric, at the level the
 * composer sees it: each commit is laid out in one pass, and that pass sends
 * layout events whose handlers run later, against the props committed then.
 * The geometry is the row's flex layout; the text engine is a fixture of 8
 * points a character. This proves the event protocol, not device text
 * layout parity.
 */
const ATTACH = 44
const SEND = 44
const CHAR = 8

/** The editing row as Yoga lays it out: the editor keeps 40%, the model control shrinks first. */
function editingRow(surfaceWidth: number, modelWidth: number) {
  const editor = Math.max(0.4 * surfaceWidth, surfaceWidth - ATTACH - modelWidth - SEND)
  return { leading: ATTACH, trailing: surfaceWidth - ATTACH - editor, textWidth: editor - 8 - 2 }
}

/** The hidden copy's frame as Yoga resolves an absolute view with left, right and minWidth. */
function frameTextWidth(surfaceWidth: number, chrome: { leading: number; trailing: number }) {
  const frame = oneRowMeasureFrame(chrome)
  const minWidth = (Number.parseFloat(frame.minWidth) / 100) * surfaceWidth
  return Math.max(surfaceWidth - frame.left - frame.right, minWidth) - frame.paddingLeft - frame.paddingRight
}

function layoutLines(text: string, width: number) {
  const perLine = Math.max(1, Math.floor(width / CHAR))
  const lines: { text: string }[] = []
  for (let start = 0; start < text.length; start += perLine) lines.push({ text: text.slice(start, start + perLine) })
  return lines
}

const truthUsesCard = (text: string, surfaceWidth: number, modelWidth: number) =>
  text.length * CHAR > editingRow(surfaceWidth, modelWidth).textWidth

class ComposerModel {
  text = ''
  label = 'Opus'
  leading: number | null = null
  trailing: { label: string; width: number } | null = null
  fits = true

  usesCard() {
    const trailing = this.trailing?.label === this.label ? this.trailing.width : null
    return composerUsesCard({
      editing: true,
      text: this.text,
      hasEditingAttachments: false,
      rowMeasured: this.leading !== null && trailing !== null,
      fitsOneRow: this.fits,
    })
  }

  /** One commit's layout pass; returns its events, not yet delivered. */
  layoutPass(surfaceWidth: number, modelWidth: number): Array<() => void> {
    const events: Array<() => void> = []
    const label = this.label
    if (!this.usesCard()) {
      const row = editingRow(surfaceWidth, modelWidth)
      events.push(() => { this.leading = row.leading })
      events.push(() => { this.trailing = { label, width: row.trailing } })
    }
    const trailing = this.trailing?.label === label ? this.trailing.width : null
    if (this.leading !== null && trailing !== null) {
      const lines = layoutLines(measuredDraftText(this.text), frameTextWidth(surfaceWidth, { leading: this.leading, trailing }))
      // The handler compares with the draft committed when it runs.
      events.push(() => {
        const verdict = oneRowVerdict(measuredDraftText(this.text), lines)
        if (verdict !== null) this.fits = verdict
      })
    }
    return events
  }

  /** Lays out and delivers until nothing changes; returns the layout shown after each pass. */
  settle(surfaceWidth: number, modelWidth: number, order: 'fifo' | 'reversed'): boolean[] {
    const shown: boolean[] = []
    let previous = ''
    for (let pass = 0; pass < 10; pass++) {
      const events = this.layoutPass(surfaceWidth, modelWidth)
      for (const event of order === 'fifo' ? events : events.reverse()) event()
      shown.push(this.usesCard())
      const state = JSON.stringify([this.leading, this.trailing, this.fits, this.usesCard()])
      if (state === previous) break
      previous = state
    }
    return shown
  }
}

const changes = (shown: boolean[], before: boolean) =>
  shown.reduce((count, card, index) => count + (card !== (index === 0 ? before : shown[index - 1]) ? 1 : 0), 0)

describe('row measurement under any layout event order', () => {
  for (const order of ['fifo', 'reversed'] as const) {
    test(`narrowing and widening across the wrap boundary changes the layout once and lands on the truth (${order})`, () => {
      const composer = new ComposerModel()
      composer.text = 'x'.repeat(19) // 152 points
      const model = 100
      let before = false
      for (const surfaceWidth of [360, 340, 360, 330, 520, 340]) {
        const shown = composer.settle(surfaceWidth, model, order)
        expect(shown.at(-1)).toBe(truthUsesCard(composer.text, surfaceWidth, model))
        expect(changes(shown, before)).toBeLessThanOrEqual(1)
        before = shown.at(-1)!
      }
    })

    test(`a model control measured shrunk corrects within one row visit and then holds (${order})`, () => {
      const composer = new ComposerModel()
      const model = 100
      composer.text = 'x'.repeat(10)
      composer.settle(250, model, order) // the editor sits at its 40% minimum; the model control shrinks
      composer.text = 'x'.repeat(26) // 208 points
      expect(composer.settle(250, model, order).at(-1)).toBe(true)
      const widened = composer.settle(400, model, order)
      expect(widened.at(-1)).toBe(truthUsesCard(composer.text, 400, model))
      expect(changes(widened, true)).toBeLessThanOrEqual(2)
      // Settled: further passes at the same width change nothing.
      expect(composer.settle(400, model, order).every((card) => card === widened.at(-1))).toBe(true)
    })

    test(`a new model label while the card shows is measured again instead of locking the card (${order})`, () => {
      const composer = new ComposerModel()
      composer.text = 'x'.repeat(19)
      expect(composer.settle(340, 100, order).at(-1)).toBe(true)
      composer.label = 'Haiku' // a shorter label: the row now has room
      const shown = composer.settle(340, 40, order)
      expect(shown.at(-1)).toBe(truthUsesCard(composer.text, 340, 40))
      expect(shown.at(-1)).toBe(false)
    })
  }
})

describe('stale text layouts', () => {
  const measuredComposer = () => {
    const composer = new ComposerModel()
    composer.settle(360, 100, 'fifo')
    return composer
  }

  test('a layout of the wrapped draft that arrives after a delete cannot set the card', () => {
    const composer = measuredComposer()
    composer.text = 'x'.repeat(30)
    const wrappedPass = composer.layoutPass(360, 100)
    composer.text = 'x'.repeat(5) // deleted before the wrapped layout was delivered
    const shortPass = composer.layoutPass(360, 100)
    for (const event of shortPass) event()
    for (const event of wrappedPass) event() // late
    expect(composer.fits).toBe(true)
    expect(composer.usesCard()).toBe(false)
  })

  test('typing past the edge then sending: the queued layouts end on an empty row', () => {
    const composer = measuredComposer()
    composer.text = 'x'.repeat(18)
    const fitsPass = composer.layoutPass(360, 100)
    composer.text = 'x'.repeat(21)
    const wrapPass = composer.layoutPass(360, 100)
    composer.text = '' // sent
    const sentPass = composer.layoutPass(360, 100)
    for (const event of [...fitsPass, ...wrapPass, ...sentPass]) event()
    expect(composer.usesCard()).toBe(false)
    composer.text = 'x'.repeat(3)
    expect(composer.usesCard()).toBe(false)
  })

  test('in order, each layout applies to its own draft', () => {
    const composer = measuredComposer()
    composer.text = 'x'.repeat(21)
    for (const event of composer.layoutPass(360, 100)) event()
    expect(composer.usesCard()).toBe(true)
    composer.text = 'x'.repeat(4)
    for (const event of composer.layoutPass(360, 100)) event()
    expect(composer.usesCard()).toBe(false)
  })
})

describe('Android keyboard after an app switch (T3 #20803)', () => {
  test('a composer focused through the switch keeps its keyboard and stays above it', () => {
    const guard = new KeyboardResumeGuard()
    guard.keyboardEvent('keyboardWillShow')
    guard.composerFocusChanged(true)
    expect(guard.suspectOnResume()).toBe(false)
  })

  test('send then Home: the composer blurred and the hide started, so the state is quarantined', () => {
    const guard = new KeyboardResumeGuard()
    guard.composerFocusChanged(true)
    guard.composerFocusChanged(false)
    guard.keyboardEvent('keyboardWillHide')
    expect(guard.suspectOnResume()).toBe(true)
  })

  test('Back then Home during the hide keeps focus but is still quarantined', () => {
    const guard = new KeyboardResumeGuard()
    guard.composerFocusChanged(true)
    guard.keyboardEvent('keyboardWillHide')
    expect(guard.suspectOnResume()).toBe(true)
  })

  test('a hide that finished, or a keyboard shown again, no longer counts as in progress', () => {
    const guard = new KeyboardResumeGuard()
    guard.composerFocusChanged(true)
    guard.keyboardEvent('keyboardWillHide')
    guard.keyboardEvent('keyboardDidHide')
    expect(guard.suspectOnResume()).toBe(false)
    guard.keyboardEvent('keyboardWillHide')
    guard.keyboardEvent('keyboardWillShow')
    expect(guard.suspectOnResume()).toBe(false)
  })

  test('a question that hides the focused composer takes its ownership, and gives it back when answered', () => {
    const guard = new KeyboardResumeGuard()
    guard.composerFocusChanged(true)
    guard.questionShownChanged(true)
    expect(guard.suspectOnResume()).toBe(true)
    guard.questionShownChanged(false)
    expect(guard.suspectOnResume()).toBe(false)
  })

  test('a thread change releases focus that the replaced editor never reported', () => {
    const guard = new KeyboardResumeGuard()
    guard.composerFocusChanged(true)
    guard.composerFocusChanged(false) // ThreadDetailScreen's thread-change layout effect
    expect(guard.suspectOnResume()).toBe(true)
  })
})

// Native presentation without logic to run in bun: these check the contract
// the review asked for (callbacks and accessible names kept), not styling.
describe('Android menu icons take taps (T3 #20802)', () => {
  test('every hosted icon runs its row action, without becoming a second accessible or focusable target', () => {
    const menu = read('src/components/MaterialMenuPopup.android.tsx')
    expect(menu).toMatch(/<Pressable\s+accessible=\{false\}\s+focusable=\{false\}\s+disabled=\{props\.disabled\}\s+onPress=\{props\.onPress\}/)
    const icons = menu.split('<MenuIcon').slice(1).map((chunk) => chunk.slice(0, chunk.indexOf('/>')))
    expect(icons.length).toBe(4)
    for (const icon of icons) expect(icon).toContain('onPress=')
  })
})

describe('sheet close and apply affordances (T3 #21319)', () => {
  test('the generic sheet dismisses with an X that keeps its Close name and the owner callback', () => {
    const sheet = read('src/components/AppSheet.tsx')
    expect(sheet).toContain('icon: { type: "sfSymbol", name: "xmark" }')
    expect(sheet).toContain('accessibilityLabel: `Close ${props.title}`')
    expect(sheet).toContain('onDismiss={props.onClose}')
  })

  test('session settings: X never says Cancel; the confirmation exists only for a staged model', () => {
    const settings = read('src/features/threads/ThreadSettingsSheet.tsx')
    expect(settings).not.toContain('Cancel session settings')
    // T3 #21978: both platforms use SheetHeader; iOS shows the checkmark, Android the Save label.
    expect(settings).toMatch(/session\.pendingModel\s*\?\s*\{ label: "Save session settings", onPress: commitAndClose \}\s*:\s*undefined/)
    expect(settings).toMatch(/session\.pendingModel \? \{ label: "Save", onPress: commitAndClose \} : undefined/)
  })
})

describe('shared sheet header (T3 #21978)', () => {
  test('iOS: an X that dismisses on the left, a prominent checkmark only when the sheet confirms', () => {
    const header = read('src/components/SheetHeader.tsx')
    expect(header).toMatch(/placement="left">\s*<NativeHeaderToolbar\.Button\s+icon="xmark"/)
    expect(header).toContain('onPress={props.onCancel ?? props.onClose}')
    expect(header).toContain('disabled={props.dismissDisabled}')
    expect(header).toMatch(/\{confirmation \? \(\s*<NativeHeaderToolbar placement="right">\s*<NativeHeaderToolbar\.Button\s+icon="checkmark"\s+variant="prominent"/)
    expect(header).toContain('accessibilityLabel={confirmation.label}')
  })

  test('Android: an X and a labeled confirmation; inline sheets use the embedded bar', () => {
    const header = read('src/components/SheetHeader.android.tsx')
    expect(header).toContain('icon="xmark"')
    expect(header).toContain('<MaterialButton label={confirmation.label} tone="text" onPress={confirmation.onPress} />')
    expect(header).toContain('embedded={props.presentation === "inline"}')
  })

  test('a pull request sheet cannot be dismissed while a write runs (T3 #22390)', () => {
    const content = read('src/features/prs/detail/PullRequestSheetContent.tsx')
    expect(content).toContain('dismissDisabled={props.busy}')
    expect(content).toContain('gestureEnabled: !props.busy')
  })
})

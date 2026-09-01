import { describe, expect, test } from 'bun:test'
import { centringPadding } from '../../src/renderer/components/pickers/lib/conversation-bounds'

// The directory picker's scrim covers the whole window, but the dialog belongs to
// the conversation it was opened from. These tests pin that relationship: the
// padding is what turns a full-bleed overlay's centring box into the column.
describe('conversation centring', () => {
  test('pads the scrim down to the column so the dialog sits on its axis', () => {
    // 1600px window, a 260px sidebar, a 340px side panel: the column runs
    // 260 → 1260, so its centre is 760 — not the window's 800.
    expect(centringPadding({ left: 260, width: 1000 }, 1600)).toBe(
      'padding-left:260px;padding-right:340px',
    )
  })

  test('never pads negative when the measurement lags the window', () => {
    // A window shrunk between measurements would otherwise yield a negative
    // right gutter, which pushes the dialog off-axis instead of leaving it be.
    expect(centringPadding({ left: 260, width: 1000 }, 900)).toBe(
      'padding-left:260px;padding-right:0px',
    )
  })

  test('leaves the overlay centred on the window when there is no column', () => {
    // Pill mode and the standalone client never render a conversation column.
    expect(centringPadding(null, 1600)).toBe('')
  })
})

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  hasLeftPress,
  TOUCH_SLOP_PX,
} from '@solus/workspace-ui/components/session/unified-picker/lib/picker-long-press'

// Section 3 of `Unified Picker.dc.html` — "The unified picker on mobile" —
// specifies a phone that is not the desktop overlay narrowed. Two rules carry
// the whole design:
//
//   "Tapping never opens a preview: a task row opens the task, a session row
//    resumes the session."
//   "The preview is the redesign's long-press peek … raised over the list it
//    came from, so dismissing returns to the same scroll position."
//
// Everything below pins one of those two rules, or the information a phone row
// has room to state once the preview column is gone.

const UI = new URL('../../packages/workspace-ui/src/', import.meta.url).pathname
const PICKER = `${UI}components/session/unified-picker/`

const picker = readFileSync(`${PICKER}UnifiedPicker.svelte`, 'utf8')
const row = readFileSync(`${PICKER}UnifiedPickerRow.svelte`, 'utf8')
const peek = readFileSync(`${PICKER}PickerPeekSheet.svelte`, 'utf8')
const preview = readFileSync(`${UI}components/session/SessionPreview.svelte`, 'utf8')
const sheet = readFileSync(`${UI}components/ui/bottom-sheet/bottom-sheet.svelte`, 'utf8')

/** The body of `activate`, the one function both a tap and ⏎ go through. */
const activateBody = picker.slice(
  picker.indexOf('function activate('),
  picker.indexOf('function stepIn('),
)

describe('the unified picker on a phone', () => {
  test('a task row goes to the task on a phone and resumes on desktop', () => {
    // WHY: this is the one behaviour the phone deliberately does not share with
    // the desktop overlay, so it is the one a later "why are these different?"
    // cleanup would quietly delete. Desktop can promise "resume latest" because
    // its footer says ⏎ resumes and its preview shows what would resume; a
    // phone has neither, and a row that silently starts an agent is a worse
    // surprise than a row that shows you the task.
    expect(activateBody).toContain('runtime.isMobileViewport')
    expect(activateBody).toContain('openTaskPage(entry.task)')
    expect(activateBody).toContain('select(entry.task)')
  })

  test('a session row resumes on every surface', () => {
    // WHY: the spec draws no phone/desktop split for a session — it is the same
    // move either way, so the branch above must not grow a second arm.
    expect(activateBody).toContain('selectSession(entry.session)')
    expect(activateBody.match(/isMobileViewport/g)).toHaveLength(1)
  })

  test('the peek is the only preview a tap can reach, and long press is what raises it', () => {
    // WHY: with tapping spent on navigation, the press-and-hold is the phone's
    // *only* route to a preview and to the row's actions. If it stops raising a
    // sheet, a phone loses the surface entirely rather than degrading.
    expect(picker).toContain('peekTarget =')
    expect(picker).toContain('event.pointerType !== "touch"')
    // Dismissing restores the list rather than rebuilding it: the sheet closes
    // by clearing its own target, never by closing the picker underneath.
    expect(picker).toContain('onClose={() => (peekTarget = null)}')
  })

  test('the task peek commits to the task and always offers a draft', () => {
    // WHY: the peek's primary has to say the same thing the row it was raised
    // from does, or the sheet teaches a different rule than the list. "New
    // draft" is unconditional because a task with no sessions has no other way
    // to start work, and the sessions roll inside the sheet is where resuming
    // an existing one lives.
    expect(peek).toContain('primaryLabel="Open task"')
    expect(peek).toContain('secondaryLabel="New draft"')
    expect(peek).not.toContain('"Resume latest"')
  })

  test('the session peek names its task and the size of the transcript', () => {
    // WHY: a session label alone ("Restore top-scroll after reload") does not
    // say what work it belongs to, and the phone's list row cannot show the
    // parent either. The sheet is the only place with room, so the header line
    // spends itself on the task rather than repeating the project — which the
    // task peek already carries.
    expect(peek).toContain('{target.task.title}')
    expect(peek).toContain('{messageCount === 1 ? "message" : "messages"}')
    // The count is absent until the read lands; a placeholder "0 messages"
    // would be a lie about an unread transcript.
    expect(peek).toContain('{#if messageCount !== undefined}')
  })

  test('the session peek offers Fork only where a fork can happen', () => {
    // WHY: the spec draws Fork beside Resume, but a fork branches a live
    // provider thread. A durable row has none until it is resumed, so an
    // always-on Fork would be a button that cannot do its job.
    expect(peek).toContain('secondaryLabel={onFork ? "Fork" : undefined}')
    expect(picker).toContain('onFork={canFork(peekTarget) ? forkSession : undefined}')
    expect(picker).toContain('agentSessionId')
  })

  test('a phone session row states the last reply instead of repeating the age', () => {
    // WHY: the status glyph already says running or idle, so those words spend
    // the second line on something the reader can already see. The spec puts
    // recency there instead — and once it is there, the trailing age chip is
    // the same number twice on a 393px row.
    expect(row).toContain('max-md:block">last reply {relativeTime(')
    expect(row).not.toContain('"running" : "idle"')
    expect(row).toMatch(/tabular-nums text-muted-foreground opacity-60 max-md:hidden/)
  })

  test('a held finger keeps its press; a scroll ends it', () => {
    // WHY: the first version cancelled the press on any `pointermove`, and a
    // finger resting on glass emits those continuously — so the peek was
    // unreachable on the one surface it exists for. The rule has to separate a
    // hold from a scroll by distance, not by whether the pointer moved at all.
    const origin = { x: 200, y: 400 }
    expect(hasLeftPress(origin, 200, 400)).toBe(false)
    expect(hasLeftPress(origin, 203, 402)).toBe(false)
    expect(hasLeftPress(origin, 200, 400 + TOUCH_SLOP_PX)).toBe(false)
    // A scroll travels, and it must still cancel — dragging the list past a row
    // is not a request to preview that row.
    expect(hasLeftPress(origin, 200, 440)).toBe(true)
    expect(hasLeftPress(origin, 260, 400)).toBe(true)
  })

  test('the peek outranks the picker it is raised from', () => {
    // WHY: the sheet portals into the popover layer so the picker's scrim does
    // not cover it — and then sat at `z-50` under a `z-[200]` picker that fills
    // a phone edge to edge. It mounted, animated and took the keyboard while
    // being invisible, which reads exactly like "long press does nothing".
    expect(sheet).toContain('z-[210]')
    expect(sheet).toContain('z-[211]')
    expect(picker).toContain('z-[200]')
  })

  test('the click swallowed after a long press is only that press own click', () => {
    // WHY: raising the sheet has to eat the click of the lift that raised it,
    // but the guard was left standing afterwards — so the next real tap, on any
    // row, at any later moment, silently did nothing.
    expect(picker).toContain('onPressEnd={endPress}')
    expect(picker).toMatch(/requestAnimationFrame\(\(\) => \{\s*suppressNextClick = false;/)
  })

  test('the collapsed middle says when the reply it introduces landed', () => {
    // WHY: the peek shows two messages out of many, so the divider is the only
    // place that can date the reply below it. Without the time, a two-message
    // sheet reads as a live conversation whatever its age.
    expect(preview).toContain('{timeAgo ? ` ${timeAgo}` : ""}')
  })
})

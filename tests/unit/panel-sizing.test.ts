import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'
import { gutterWidth } from '../../src/renderer/components/conversation/lib/minimap'
import {
  defaultWorkspaceRailWidth,
  MIN_PRIMARY_PANE_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from '../../src/renderer/components/layout/lib/workspace-body'
import {
  isProjectRailOpen,
  projectRailWidth,
} from '../../src/renderer/components/project-panel/lib/rail-width'

// Both rails are a share of the window rather than one fixed width, and they are
// the same share — the sidebar on the left and the project rail on the right are
// the same furniture on the same display. These tests walk the displays Solus
// actually runs on and pin the rules that make that model correct: the rails
// shrink together on a small screen instead of crowding the conversation, they
// match each other everywhere, and they stop growing before a large display
// turns either into an empty column.

/** Logical CSS width of each supported display, narrowest first. */
const DISPLAYS = [
  { name: 'iPad portrait', width: 834 },
  { name: 'iPad landscape', width: 1194 },
  { name: '13" MacBook Air', width: 1280 },
  { name: '15" laptop window', width: 1440 },
  { name: '15" MacBook Pro (1512 × 982 display mode)', width: 1512 },
  { name: '16" MacBook Pro', width: 1728 },
  { name: '5K display', width: 2560 },
]

/** What the two rails leave for the conversation on a given display. */
function conversationWidth(displayWidth: number): number {
  const sidebar = defaultWorkspaceRailWidth(displayWidth)
  const beside = displayWidth - sidebar
  return isProjectRailOpen(true, beside)
    ? beside - projectRailWidth(displayWidth, beside)
    : beside
}

describe('panel sizing across displays', () => {
  test('the conversation keeps its minimum on every display, both panels open', () => {
    // WHY: this is the failure the percentages exist to prevent. A fixed panel
    // width that reads well on a 16" leaves an iPad with a conversation too
    // narrow to hold a message and its composer.
    for (const display of DISPLAYS) {
      expect(conversationWidth(display.width)).toBeGreaterThanOrEqual(MIN_PRIMARY_PANE_WIDTH)
    }
  })

  test('the two rails are the same width on every display', () => {
    // WHY: the left and right rails frame the same conversation. Two different
    // widths read as an accident, and that is what separate bands produced.
    for (const display of DISPLAYS) {
      const sidebar = defaultWorkspaceRailWidth(display.width)
      const beside = display.width - sidebar
      if (!isProjectRailOpen(true, beside)) continue
      expect(projectRailWidth(display.width, beside)).toBe(sidebar)
    }
  })

  test('both rails grow with the display, never shrink as it widens', () => {
    for (let i = 1; i < DISPLAYS.length; i++) {
      const smaller = DISPLAYS[i - 1]!.width
      const larger = DISPLAYS[i]!.width
      expect(defaultWorkspaceRailWidth(larger)).toBeGreaterThanOrEqual(
        defaultWorkspaceRailWidth(smaller),
      )
    }
  })

  test('both rails use the responsive width at each display size', () => {
    // WHY: matching is not enough if both rails stay large on a small screen.
    // These are the actual clamp(200px, 17%, 380px) results for the supported
    // logical display widths.
    const expected = [200, 203, 218, 245, 257, 294, 380]
    expect(DISPLAYS.map((display) => defaultWorkspaceRailWidth(display.width))).toEqual(
      expected,
    )
  })

  test('a tablet takes the floor and a large display the cap', () => {
    // WHY: the band is the whole design. Without the floor a tablet gets a rail
    // too narrow to read a session title in; without the cap an ultrawide keeps
    // widening a column that holds one line of text per row.
    expect(defaultWorkspaceRailWidth(834)).toBe(SIDEBAR_MIN_WIDTH)
    expect(defaultWorkspaceRailWidth(2560)).toBeLessThanOrEqual(SIDEBAR_MAX_WIDTH)
    expect(defaultWorkspaceRailWidth(2560)).toBe(defaultWorkspaceRailWidth(5120))
  })

  test('the conversation measure grows with the display but slower than it', () => {
    // WHY: the two ways to get this wrong are symmetrical, and one round of
    // tuning hit each. A share of the pane that reads well on a laptop runs a 5K
    // display's text to ~135 characters; a fixed cap tuned for the laptop leaves
    // the 5K a narrow ribbon in an empty window. The measure must move with the
    // display, by less than the display moves, then stop at a readable cap.
    const measure = (displayWidth: number) => {
      const pane = conversationWidth(displayWidth)
      return pane - gutterWidth(pane) * 2
    }
    const laptop = measure(1440)
    const fiveK = measure(2560)
    expect(fiveK).toBeGreaterThan(laptop)
    expect(fiveK - laptop).toBeLessThan(conversationWidth(2560) - conversationWidth(1440))
    // Neither end is allowed to collapse into the other's failure: a readable
    // laptop line, and a 5K that is not mostly gutter.
    expect(laptop).toBeGreaterThan(700)
    expect(fiveK).toBe(68 * 16)
  })

  test('the navigator mirror still matches the reading column it copies', () => {
    // The rail's gutter math duplicates --solus-reading-max in TypeScript. The
    // two drift silently — the column just resizes and the rail keeps using the
    // old numbers — so the token is read back here rather than trusted.
    const css = readFileSync(
      new URL('../../src/renderer/index.css', import.meta.url),
      'utf8',
    )
    const token = css.match(
      /--solus-reading-max: clamp\(([\d.]+)rem, ([\d.]+)%, ([\d.]+)rem\)/,
    )
    expect(token).not.toBeNull()
    const [, min, percent, max] = token!
    const column = (pane: number) => pane - gutterWidth(pane) * 2
    // A pane wide enough to sit on the cap, one narrow enough to sit on the
    // floor, and one in the percentage band.
    expect(column(3000)).toBe(Number(max) * 16)
    expect(column(520)).toBe(Number(min) * 16)
    const inBand = 1200
    expect(column(inBand)).toBeCloseTo(
      (inBand - 32) * (Number(percent) / 100),
      6,
    )
  })

  test('the reading column contracts with narrow conversation panes', () => {
    // WHY: widening the 5K layout must not introduce a desktop-sized fixed
    // column into a tablet, a narrow window, or a split. The max-width can sit
    // above the pane, but the rendered column must never exceed its inner box.
    for (const pane of [360, 480, 600, 800]) {
      expect(pane - gutterWidth(pane) * 2).toBeLessThanOrEqual(pane - 32)
    }
    expect(800 - gutterWidth(800) * 2).toBeCloseTo((800 - 32) * 0.8, 6)
  })

  test('a session draft keeps its compact composer measure', () => {
    // WHY: drafts place one prompt below one headline. They must respond to a
    // narrow pane, but must not inherit the wider transcript cap on a laptop or
    // large monitor.
    const source = readFileSync(
      new URL(
        '../../src/renderer/components/session-draft/SessionDraftPane.svelte',
        import.meta.url,
      ),
      'utf8',
    )
    expect(source).toContain('class="draft-column ')
    expect(source).toContain('--solus-reading-max: clamp(40rem, 50%, 52rem)')
  })

  test('a laptop lands inside the band rather than on either bound', () => {
    // MacBook Pro and nearby laptop widths should read the percentage, not sit
    // pinned to either limit. 1512px is the user's 15" 1512 × 982 display mode.
    for (const width of [1440, 1512, 1728]) {
      const sidebar = defaultWorkspaceRailWidth(width)
      expect(sidebar).toBeGreaterThan(SIDEBAR_MIN_WIDTH)
      expect(sidebar).toBeLessThan(SIDEBAR_MAX_WIDTH)
    }
  })
})

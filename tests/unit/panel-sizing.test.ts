import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { ConversationWidth } from '@solus/contracts/settings'
import { gutterWidth, hasRoomForRail } from '@solus/workspace-ui/components/conversation/lib/minimap'
import {
  defaultWorkspaceRailWidth,
  MIN_PRIMARY_PANE_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from '@solus/workspace-ui/components/layout/lib/workspace-body'
import {
  isProjectRailOpen,
  projectRailWidth,
} from '@solus/workspace-ui/components/project-panel/lib/rail-width'

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

/** The rendered reading column in a conversation pane. */
function column(pane: number, width: ConversationWidth): number {
  return pane - gutterWidth(pane, width) * 2
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
      return pane - gutterWidth(pane, 'comfortable') * 2
    }
    const laptop = measure(1440)
    const fiveK = measure(2560)
    expect(fiveK).toBeGreaterThan(laptop)
    expect(fiveK - laptop).toBeLessThan(conversationWidth(2560) - conversationWidth(1440))
    // A laptop uses the requested share; a 5K stops at the reading cap.
    expect(laptop).toBeCloseTo((conversationWidth(1440) - 32) * 0.65, 6)
    expect(fiveK).toBe(68 * 16)
  })

  test('the reading column contracts with narrow conversation panes', () => {
    // WHY: widening the 5K layout must not introduce a desktop-sized fixed
    // column into a tablet, a narrow window, or a split. The max-width can sit
    // above the pane, but the rendered column must never exceed its inner box.
    for (const width of ['narrow', 'comfortable', 'full'] as const) {
      for (const pane of [360, 480, 600, 800]) {
        expect(pane - gutterWidth(pane, width) * 2).toBeLessThanOrEqual(pane - 32)
      }
    }
  })

  test('a narrow pane gives its width to the text, not to margins', () => {
    // WHY: a share of the pane reads well on a laptop, but in a small window or
    // a split it left a third of the width empty. Below the 46rem floor the
    // column fills the pane less a 3rem margin each side (t3code's margin), and
    // no navigator rail takes the space back.
    for (const pane of [360, 480, 600, 800]) {
      expect(column(pane, 'comfortable')).toBe(pane - 96)
      expect(hasRoomForRail(pane, 'comfortable')).toBe(false)
    }
    expect(column(900, 'comfortable')).toBe(46 * 16)
  })

  test('each conversation width keeps its own measure on a wide pane', () => {
    // WHY: the setting is the person's choice of measure. Narrow holds the
    // comfortable rule's floor, Full fills the pane, and Comfortable sits
    // between them on every display, so Narrow is never the wider choice.
    for (const display of DISPLAYS) {
      const pane = conversationWidth(display.width)
      expect(column(pane, 'narrow')).toBeLessThanOrEqual(column(pane, 'comfortable'))
      expect(column(pane, 'comfortable')).toBeLessThanOrEqual(column(pane, 'full'))
    }
    const pane = conversationWidth(1728)
    expect(column(pane, 'narrow')).toBe(40 * 16)
    expect(column(pane, 'full')).toBe(pane - 32)
    expect(column(pane, 'comfortable')).toBeGreaterThan(column(pane, 'narrow'))
    expect(column(pane, 'comfortable')).toBeLessThan(column(pane, 'full'))
    // A full column leaves no gutter for the navigator rail.
    expect(hasRoomForRail(pane, 'full')).toBe(false)
    expect(hasRoomForRail(pane, 'narrow')).toBe(true)
  })

  test('the stylesheet paints the widths the navigator assumes', () => {
    // WHY: the navigator rail places itself in the gutter it computes. If the
    // CSS rule changes alone, the rail sits on the text or leaves a hole.
    const css = readFileSync(new URL('../../packages/workspace-ui/src/workspace.css', import.meta.url), 'utf8')
    expect(css).toContain('--solus-reading-max: min(68rem, max(65%, min(100% - 4rem, 46rem)));')
    expect(css).toMatch(/\[data-conversation-width='narrow'\] \{\s*--solus-reading-max: min\(100% - 4rem, 40rem\);/)
    expect(css).toMatch(/\[data-conversation-width='full'\] \{\s*--solus-reading-max: 100%;/)
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

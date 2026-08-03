import { describe, expect, test } from 'bun:test'
import {
  applyLocation,
  closeOverlay,
  closePane,
  initialLocation,
  makePane,
  movePane,
  place,
  visibleRef,
  MAX_PANES,
  type Location,
} from '../../src/renderer/contexts/workspace/routing/location'
import { CHAT_ROUTE, chatRoute, type RouteRef } from '../../src/renderer/contexts/workspace/routing/route-registry'

// The placement rules used to be spread across openPage / setArtifact /
// moveToSecondary / dockPrReview / closeSlot, where none of them could be
// tested. They are one pure function now, so each rule gets pinned here.

const TASKS: RouteRef = { name: 'tasks', params: {} }
const PRS: RouteRef = { name: 'prs', params: {} }
const PLAN: RouteRef = { name: 'plan', params: { planId: 'p_1' } }
const WORK: RouteRef = { name: 'work', params: { workId: 'w_1' } }
const PR_REVIEW: RouteRef = { name: 'prReview', params: { number: 4821 } }
const DIFF: RouteRef = { name: 'diff', params: { sourceTabId: 'tab_a' } }

function locationWith(...refs: (RouteRef | null)[]): Location {
  const panes = refs.map((ref) => makePane(ref))
  return { panes, focusedPaneId: panes[0].id }
}

describe('placing a route', () => {
  test('a page replaces the page that is open, wherever it lives', () => {
    const location = locationWith(CHAT_ROUTE, TASKS)
    const companion = location.panes[1]

    place(location, PRS, 'focused')

    expect(location.panes).toHaveLength(2)
    expect(location.panes[1].base).toEqual(PRS)
    expect(location.panes[0].base).toEqual(CHAT_ROUTE)
    // Replaced in place, so a split layout stays split rather than migrating
    // the page back into the leading pane.
    expect(location.panes[1]).toBe(companion)
  })

  test('one artifact across all panes, whichever pane already holds one', () => {
    const location = locationWith(PLAN, chatRoute('tab_b'))

    place(location, WORK, 'aside')

    expect(location.panes.map((pane) => pane.base)).toEqual([WORK, chatRoute('tab_b')])
  })

  test("an 'aside' route never takes the leading pane", () => {
    const location = locationWith(CHAT_ROUTE)

    place(location, PR_REVIEW, 'focused')

    expect(location.panes[0].base).toEqual(CHAT_ROUTE)
    expect(location.panes[1].base).toEqual(PR_REVIEW)
  })

  test("'new' appends until the cap, then replaces the trailing pane", () => {
    // Written against the cap rather than against two, so raising MAX_PANES is
    // a constant here too.
    const location = locationWith(CHAT_ROUTE)
    for (let i = location.panes.length; i < MAX_PANES; i += 1) {
      place(location, chatRoute(`tab_${i}`), 'new')
    }
    expect(location.panes).toHaveLength(MAX_PANES)

    place(location, PLAN, 'new')

    expect(location.panes).toHaveLength(MAX_PANES)
    expect(location.panes[MAX_PANES - 1].base).toEqual(PLAN)
  })

  test('an overlay covers a pane rather than replacing its base', () => {
    const location = locationWith(CHAT_ROUTE, PLAN)

    place(location, DIFF, 'aside')

    expect(location.panes[1].base).toEqual(PLAN)
    expect(location.panes[1].overlay).toEqual(DIFF)
    expect(visibleRef(location.panes[1])).toEqual(DIFF)
  })

  test('navigating one pane leaves the other pane object identical', () => {
    // The regression that would silently cost render performance: a new object
    // reference invalidates every `$derived` reading it, so an untouched pane
    // must keep its identity across a navigation elsewhere.
    const location = locationWith(CHAT_ROUTE, TASKS)
    const leading = location.panes[0]
    const leadingBase = leading.base

    place(location, PRS, location.panes[1].id)

    expect(location.panes[0]).toBe(leading)
    expect(location.panes[0].base).toBe(leadingBase)
  })

  test('re-navigating to the same route does not replace the ref', () => {
    const location = locationWith(CHAT_ROUTE, TASKS)
    const base = location.panes[1].base

    place(location, { name: 'tasks', params: {} }, location.panes[1].id)

    expect(location.panes[1].base).toBe(base)
  })
})

describe('closing panes', () => {
  test('the leading pane falls back to the conversation instead of vanishing', () => {
    const location = locationWith(PLAN)

    closePane(location, location.panes[0].id)

    expect(location.panes).toHaveLength(1)
    expect(location.panes[0].base).toEqual(CHAT_ROUTE)
  })

  test('closing a companion removes it and returns focus to the lead', () => {
    const location = locationWith(CHAT_ROUTE, PR_REVIEW)
    location.focusedPaneId = location.panes[1].id

    closePane(location, location.panes[1].id)

    expect(location.panes).toHaveLength(1)
    expect(location.focusedPaneId).toBe(location.panes[0].id)
  })

  test('a pane that exists only for its overlay closes with it', () => {
    const location = locationWith(CHAT_ROUTE)
    place(location, DIFF, 'aside')
    expect(location.panes).toHaveLength(2)

    closeOverlay(location, location.panes[1].id)

    expect(location.panes).toHaveLength(1)
  })

  test('an overlay over real content leaves that content behind', () => {
    const location = locationWith(CHAT_ROUTE, PLAN)
    place(location, DIFF, location.panes[1].id)

    closeOverlay(location, location.panes[1].id)

    expect(location.panes).toHaveLength(2)
    expect(location.panes[1].base).toEqual(PLAN)
  })

  test('the location never reaches zero panes', () => {
    const location = initialLocation()
    for (const pane of [...location.panes]) closePane(location, pane.id)
    expect(location.panes.length).toBeGreaterThan(0)
  })
})

describe('moving a route between panes', () => {
  test('out of the lead: the conversation returns, the route goes beside it', () => {
    const location = locationWith(PLAN)

    movePane(location, location.panes[0].id, 1)

    expect(location.panes.map((pane) => pane.base)).toEqual([CHAT_ROUTE, PLAN])
    expect(location.focusedPaneId).toBe(location.panes[1].id)
  })

  test('back into the lead: the companion is gone, not left holding a chat', () => {
    const location = locationWith(CHAT_ROUTE, PLAN)

    movePane(location, location.panes[1].id, -1)

    expect(location.panes).toHaveLength(1)
    expect(location.panes[0].base).toEqual(PLAN)
  })
})

describe('applying a location', () => {
  test('reuses panes by position so geometry and DOM survive back/forward', () => {
    const location = locationWith(CHAT_ROUTE, TASKS)
    const leading = location.panes[0]
    const companion = location.panes[1]

    applyLocation(location, locationWith(CHAT_ROUTE, PRS))

    expect(location.panes[0]).toBe(leading)
    expect(location.panes[1]).toBe(companion)
    expect(location.panes[1].base).toEqual(PRS)
  })

  test('drops panes the incoming location does not have', () => {
    const location = locationWith(CHAT_ROUTE, TASKS)

    applyLocation(location, locationWith(CHAT_ROUTE))

    expect(location.panes).toHaveLength(1)
    expect(location.focusedPaneId).toBe(location.panes[0].id)
  })
})

import { describe, expect, test } from 'bun:test'
import { leadingHomeRoute } from '@solus/workspace-ui/contexts/workspace/leading-home'
import { CHAT_ROUTE, type RouteRef } from '@solus/workspace-ui/contexts/workspace/routing/route-registry'

const TASKS: RouteRef = { name: 'tasks', params: {} }
const draftRoute = (draftId: string): RouteRef => ({ name: 'draft', params: { draftId } })

function drafts(...ids: string[]) {
  return new Map(ids.map((id) => [id, { id }]))
}

describe('where the leading pane lands when a page closes', () => {
  test('a workspace with a tab returns to the conversation', () => {
    // WHY: the pool has something to show, so nothing about the old fallback
    // changes for the common case.
    let minted = 0
    const home = leadingHomeRoute({
      hasTabs: true,
      leadingBase: TASKS,
      drafts: drafts('d1'),
      composingDraftIds: new Set(),
      createDraft: () => ({ id: `new_${(minted += 1)}` }),
    })

    expect(home).toEqual(CHAT_ROUTE)
    expect(minted).toBe(0)
  })

  test('with no tab, the draft the page covered comes back', () => {
    // WHY: the user opened Tasks from a composer and closed it. Landing on an
    // empty pool with a bare input bar — the reported bug — loses the composer
    // they were in; landing on a *new* draft loses what they had typed.
    const home = leadingHomeRoute({
      hasTabs: false,
      leadingBase: TASKS,
      drafts: drafts('older', 'covered'),
      composingDraftIds: new Set(),
      createDraft: () => ({ id: 'unused' }),
    })

    expect(home).toEqual(draftRoute('covered'))
  })

  test('a draft another pane is composing is not pulled into the lead', () => {
    // WHY: one draft showing in two panes would let both composers edit it.
    const home = leadingHomeRoute({
      hasTabs: false,
      leadingBase: TASKS,
      drafts: drafts('covered', 'aside'),
      composingDraftIds: new Set(['aside']),
      createDraft: () => ({ id: 'unused' }),
    })

    expect(home).toEqual(draftRoute('covered'))
  })

  test('with no tab and no draft to return to, one is minted', () => {
    const home = leadingHomeRoute({
      hasTabs: false,
      leadingBase: TASKS,
      drafts: drafts(),
      composingDraftIds: new Set(),
      createDraft: () => ({ id: 'fresh' }),
    })

    expect(home).toEqual(draftRoute('fresh'))
  })

  test('closing the composer itself with nothing behind it keeps it', () => {
    // WHY: the pane chrome's close reaches a draft pane too. With nothing
    // started there is nowhere else to go, so the close is a no-op rather than
    // a hand-off to yet another draft.
    let minted = 0
    const home = leadingHomeRoute({
      hasTabs: false,
      leadingBase: draftRoute('current'),
      drafts: drafts('current'),
      composingDraftIds: new Set(['current']),
      createDraft: () => ({ id: `new_${(minted += 1)}` }),
    })

    expect(home).toEqual(draftRoute('current'))
    expect(minted).toBe(0)
  })

  test('a lead pointing at a draft that no longer exists moves on', () => {
    // WHY: a reload can restore a location naming a draft that was never
    // persisted; that dead route must not be kept as home.
    const home = leadingHomeRoute({
      hasTabs: false,
      leadingBase: draftRoute('gone'),
      drafts: drafts(),
      composingDraftIds: new Set(),
      createDraft: () => ({ id: 'fresh' }),
    })

    expect(home).toEqual(draftRoute('fresh'))
  })
})

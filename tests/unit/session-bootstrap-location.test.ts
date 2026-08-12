import { describe, expect, test } from 'bun:test'
import {
  reconcileReloadLocation,
  restoreLocation,
} from '../../src/renderer/contexts/workspace/session-bootstrap'

describe('restored workspace location', () => {
  test('drops a route for an empty draft that was not restored', () => {
    const pane = {
      id: 'leading',
      base: { name: 'draft', params: { draftId: 'empty-draft' } },
    }
    const closed: string[] = []
    const workspace = {
      router: {
        panes: [pane],
        enter: () => {},
        closePane: (paneId: string) => closed.push(paneId),
      },
      sessionDrafts: new Map(),
      tabOrder: [],
      tabs: {},
      tabIdForSession: () => undefined,
    }

    // WHY: legacy snapshots can name an empty draft even though empty drafts are
    // now intentionally non-durable. Leaving that dead route in the leading pane
    // is what makes a restored real session appear as a blank draft.
    restoreLocation(workspace as never, '/draft/empty-draft')

    expect(closed).toEqual(['leading'])
  })

  test('keeps a written draft that was restored', () => {
    const pane = {
      id: 'leading',
      base: { name: 'draft', params: { draftId: 'written-draft' } },
    }
    const closed: string[] = []
    const workspace = {
      router: {
        panes: [pane],
        enter: () => {},
        closePane: (paneId: string) => closed.push(paneId),
      },
      sessionDrafts: new Map([['written-draft', {}]]),
      tabOrder: [],
      tabs: {},
      tabIdForSession: () => undefined,
    }

    restoreLocation(workspace as never, '/draft/written-draft')

    expect(closed).toEqual([])
  })

  test('a restored tab always wins over a composer route on reload', () => {
    const pane = {
      id: 'leading',
      base: { name: 'draft', params: { draftId: 'written-draft' } },
    }
    const closed: string[] = []
    const workspace = {
      router: {
        panes: [pane],
        closePane: (paneId: string) => closed.push(paneId),
      },
      sessionDrafts: new Map([['written-draft', {}]]),
      tabOrder: ['tab-1'],
      tabs: { 'tab-1': { id: 'tab-1' } },
      tabIdForSession: () => undefined,
    }

    // WHY: on web the address bar is applied after tab materialization. Even a
    // valid saved draft URL must not cover the session selected before reload.
    reconcileReloadLocation(workspace as never)

    expect(closed).toEqual(['leading'])
  })
})

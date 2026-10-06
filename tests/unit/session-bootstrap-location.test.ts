import { describe, expect, test } from 'bun:test'
import {
  reconcileReloadLocation,
  restoreLocation,
} from '@solus/workspace-ui/contexts/workspace/session-bootstrap'

describe('restored workspace location', () => {
  test('drops a route for an empty draft that was not restored', () => {
    const destination = { name: 'draft', params: { draftId: 'empty-draft' } }
    const closed: string[] = []
    const workspace = {
      router: {
        destination,
        leadingPane: { id: 'leading' },
        enter: () => {},
        closeSurfacesWhere: () => {},
        closePane: (paneId: string) => closed.push(paneId),
      },
      drafts: { sessionDrafts: new Map() },
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
    const destination = { name: 'draft', params: { draftId: 'written-draft' } }
    const closed: string[] = []
    const workspace = {
      router: {
        destination,
        leadingPane: { id: 'leading' },
        enter: () => {},
        closeSurfacesWhere: () => {},
        closePane: (paneId: string) => closed.push(paneId),
      },
      drafts: { sessionDrafts: new Map([['written-draft', {}]]) },
      tabOrder: [],
      tabs: {},
      tabIdForSession: () => undefined,
    }

    restoreLocation(workspace as never, '/draft/written-draft')

    expect(closed).toEqual([])
  })

  test('a restored tab always wins over a composer route on reload', () => {
    const destination = { name: 'draft', params: { draftId: 'written-draft' } }
    const closed: string[] = []
    const workspace = {
      router: {
        destination,
        leadingPane: { id: 'leading' },
        closeSurfacesWhere: () => {},
        closePane: (paneId: string) => closed.push(paneId),
      },
      drafts: { sessionDrafts: new Map([['written-draft', {}]]) },
      tabOrder: ['tab-1'],
      tabs: { 'tab-1': { id: 'tab-1' } },
      tabIdForSession: () => undefined,
    }

    // WHY: on web the address bar is applied after tab materialization. Even a
    // valid saved draft URL must not cover the session selected before reload.
    reconcileReloadLocation(workspace as never)

    expect(closed).toEqual(['leading'])
  })

  test('a surface naming a conversation or draft this boot did not restore is closed', () => {
    // WHY: a chat or draft surface with nothing behind it renders an empty
    // column beside the conversation.
    let surfaces = [
      { name: 'chat', params: { sessionId: 'kept' } },
      { name: 'chat', params: { sessionId: 'gone' } },
      { name: 'draft', params: { draftId: 'gone-draft' } },
      { name: 'task', params: { taskId: 't_1' } },
    ]
    const workspace = {
      router: {
        destination: { name: 'chat', params: {} },
        leadingPane: { id: 'leading' },
        closeSurfacesWhere: (shouldClose: (ref: (typeof surfaces)[number]) => boolean) => {
          surfaces = surfaces.filter((ref) => !shouldClose(ref))
        },
        closePane: () => {},
      },
      drafts: { sessionDrafts: new Map() },
      tabOrder: ['tab-1'],
      tabs: { 'tab-1': { id: 'tab-1' } },
      tabIdForSession: (sessionId: string) => (sessionId === 'kept' ? 'tab-1' : undefined),
    }

    reconcileReloadLocation(workspace as never)

    expect(surfaces.map((ref) => ref.name)).toEqual(['chat', 'task'])
  })
})

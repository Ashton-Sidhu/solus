import { describe, expect, test } from 'bun:test'
import { DEFAULT_PERSONAL_SETTINGS, personalSettingsDocumentSchema } from '@solus/contracts/settings'
import {
  SIDEBAR_PLACES,
  appMenuTarget,
  dropLineY,
  dropTargetAt,
  insertionIndex,
  appPinOf,
  isAppPinned,
  isPlacesLayoutChanged,
  orderedPlaces,
  pinnedRows,
  placeMenuTarget,
  shownPlaces,
  withAppMoved,
  withAppPinned,
  withPlaceMoved,
  withPlaceShown,
  type SidebarPlacesLayout,
} from '../../packages/workspace-ui/src/lib/sidebar-places'
import { appMonogram, appTileHue } from '@solus/client-core/app-tile'

const ids = (layout: SidebarPlacesLayout) => shownPlaces(layout).map((place) => place.id)
const defaults = DEFAULT_PERSONAL_SETTINGS.sidebarPlaces

describe('sidebar places', () => {
  test('a new person sees every Solus place in the default order and no pinned app', () => {
    expect(ids(defaults)).toEqual(SIDEBAR_PLACES.map((place) => place.id))
    expect(DEFAULT_PERSONAL_SETTINGS.sidebarApps).toEqual([])
    expect(isPlacesLayoutChanged(defaults)).toBe(false)
  })

  test('a hidden place leaves the column and comes back in its own position', () => {
    const hidden = withPlaceShown(defaults, 'insights', false)
    expect(ids(hidden)).not.toContain('insights')
    expect(isPlacesLayoutChanged(hidden)).toBe(true)
    expect(ids(withPlaceShown(hidden, 'insights', true))).toEqual(ids(defaults))
  })

  test('a drop moves a place after its target from above and before it from below', () => {
    const down = withPlaceMoved(defaults, 'workspace', 'insights')
    expect(ids(down)).toEqual(['automations', 'insights', 'workspace', 'prs', 'tasks', 'search'])
    const up = withPlaceMoved(down, 'search', 'automations')
    expect(ids(up)).toEqual(['search', 'automations', 'insights', 'workspace', 'prs', 'tasks'])
  })

  test('Move up and Move down swap a place with the shown neighbour the menu names', () => {
    const layout = withPlaceShown(defaults, 'automations', false)
    const target = placeMenuTarget(shownPlaces(layout), 1)
    expect(target).toMatchObject({ kind: 'place', id: 'insights', above: 'workspace', below: 'prs' })
    if (target?.kind !== 'place' || !target.above) throw new Error('no neighbour')
    expect(ids(withPlaceMoved(layout, target.id, target.above))).toEqual(['insights', 'workspace', 'prs', 'tasks', 'search'])
    expect(placeMenuTarget(shownPlaces(layout), 0)?.above).toBeNull()
  })

  test('a place a newer client added keeps its stored position, and a new place of this client joins at the end', () => {
    // `calendar` is a place this client does not know; `search` is one the stored order does not name.
    const layout = { order: ['tasks', 'calendar', 'workspace', 'automations', 'insights', 'prs'], hidden: ['calendar'] }
    expect(orderedPlaces(layout).map((place) => place.id)).toEqual(['tasks', 'workspace', 'automations', 'insights', 'prs', 'search'])
    const moved = withPlaceMoved(layout, 'search', 'tasks')
    expect(moved.order).toContain('calendar')
    expect(moved.hidden).toEqual(['calendar'])
  })
})

describe('drag to reorder', () => {
  // Three 32px buttons with 4px gaps, from y = 100.
  const buttons = [{ top: 100, bottom: 132 }, { top: 136, bottom: 168 }, { top: 172, bottom: 204 }]
  const shown = ['workspace', 'automations', 'insights'] as const

  test('a release anywhere below the last button makes the dragged one last', () => {
    for (const pointerY of [190, 206, 400]) {
      const gap = insertionIndex(buttons, pointerY)
      expect(gap).toBe(3)
      const target = dropTargetAt(shown, 0, gap)
      expect(target).toBe('insights')
      expect(ids(withPlaceMoved(defaults, 'workspace', target!)).slice(0, 3)).toEqual(['automations', 'insights', 'workspace'])
    }
  })

  test('a release in the gap between two buttons lands between them, from either side', () => {
    expect(insertionIndex(buttons, 134)).toBe(1)
    expect(dropTargetAt(shown, 2, 1)).toBe('automations')
    expect(dropTargetAt(shown, 0, 2)).toBe('automations')
    expect(dropLineY(buttons, 1)).toBe(134)
    expect(dropLineY(buttons, 3)).toBe(206)
  })

  test('a release in the gaps on either side of the dragged button moves nothing', () => {
    expect(dropTargetAt(shown, 1, 1)).toBeNull()
    expect(dropTargetAt(shown, 1, 2)).toBeNull()
  })
})

describe('pinned apps', () => {
  const local = { id: 'local', installationId: 'install-a' }
  const rows = [
    { serverId: 'local', app: { id: 'app-1', name: 'Standup' } },
    { serverId: 'remote-b', app: { id: 'app-2', name: 'Budget' } },
  ]
  const pinOfRow = (row: (typeof rows)[number]) => appPinOf(row.serverId, row.app.id, row.serverId === 'local' ? local : null)

  test('a pin names the host by its installation id, so another client finds the same app', () => {
    expect(appPinOf('local', 'app-1', local)).toEqual({ host: 'install-a', appId: 'app-1' })
    expect(appPinOf('remote-b', 'app-2', null)).toEqual({ host: 'remote-b', appId: 'app-2' })
  })

  test('pins show in pin order, and a pin with no connected app stays stored but does not show', () => {
    const away = { host: 'install-gone', appId: 'app-9' }
    const pins = [pinOfRow(rows[1]), away, pinOfRow(rows[0])]
    expect(pinnedRows(pins, rows, pinOfRow).map(({ row }) => row.app.name)).toEqual(['Budget', 'Standup'])
    expect(withAppMoved(pins, pins[2], pins[0])).toEqual([pins[2], pins[0], away])
  })

  test('pin and unpin are each other’s way back', () => {
    const pin = pinOfRow(rows[0])
    const pinned = withAppPinned([], pin, true)
    expect(isAppPinned(pinned, pin)).toBe(true)
    expect(withAppPinned(pinned, pin, true)).toEqual(pinned)
    expect(withAppPinned(pinned, pin, false)).toEqual([])
  })

  test('the menu of a pinned app names its neighbours among the apps that show', () => {
    const pinned = rows.map((row) => ({ pin: pinOfRow(row), label: row.app.name }))
    expect(appMenuTarget(pinned, 1)).toEqual({ kind: 'app', pin: pinned[1].pin, label: 'Budget', above: pinned[0].pin, below: null })
  })

  test('an app shows its first letter', () => {
    expect(appMonogram('  standup notes')).toBe('S')
    expect(appMonogram('')).toBe('?')
  })

  test('an app keeps one tile colour on every client, and two apps differ, until its owner picks one', () => {
    const hue = (id: string, colorHue: number | null = null) => appTileHue({ id, colorHue })
    expect(hue('app-1')).toBe(hue('app-1'))
    expect(hue('app-1')).not.toBe(hue('app-2'))
    expect(hue('app-1')).toBeGreaterThanOrEqual(0)
    expect(hue('app-1')).toBeLessThan(360)
    // WHY: the owner's pick is stored on the app, so every person and client draws it.
    expect(hue('app-1', 235)).toBe(235)
  })
})

describe('sidebar layout sync contract', () => {
  test('the synced document takes the layout and refuses an extra field', () => {
    const document = { sidebarPlaces: { order: ['tasks'], hidden: ['insights'] }, sidebarApps: [{ host: 'install-a', appId: 'app-1' }] }
    expect(personalSettingsDocumentSchema.safeParse(document).success).toBe(true)
    expect(personalSettingsDocumentSchema.safeParse({ sidebarApps: [{ host: 'install-a', appId: 'app-1', name: 'x' }] }).success).toBe(false)
  })
})

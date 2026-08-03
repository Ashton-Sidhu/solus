import { describe, expect, test } from 'bun:test'
import { encodeRoute, parseRouteLocation } from '../../src/renderer/contexts/workspace/routing'

describe('routing codec', () => {
  test('round-trips encoded route parameters', () => {
    const location = encodeRoute({ name: 'chat', tabId: 'tab/with spaces' })

    expect(location).toBe('#/chat/tab%2Fwith%20spaces')
    expect(parseRouteLocation(location)).toEqual({ name: 'chat', tabId: 'tab/with spaces' })
  })

  test('rejects malformed percent-encoding anywhere in the location', () => {
    expect(parseRouteLocation('#/settings/%E0%A4%A')).toEqual({ name: 'chat' })
    expect(parseRouteLocation('#/chat/%')).toEqual({ name: 'chat' })
  })

  test('rejects invalid enum-like settings tabs', () => {
    expect(parseRouteLocation('#/settings/connections')).toEqual({ name: 'chat' })
    expect(parseRouteLocation('#/settings/general')).toEqual({ name: 'settings', tab: 'general' })
    expect(parseRouteLocation('#/settings/keybindings')).toEqual({ name: 'settings', tab: 'keybindings' })
  })
})

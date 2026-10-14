import { afterAll, describe, expect, test } from 'bun:test'
// These tests verify stored choices, without a mounted Svelte renderer.
const stateDescriptor = Object.getOwnPropertyDescriptor(globalThis, '$state')
Object.defineProperty(globalThis, '$state', { configurable: true, value: <T>(value: T) => value })
const { deviceViewState, openRunApp } = await import('@solus/workspace-ui/components/devices/lib/device-view-state.svelte')
afterAll(() => {
  if (stateDescriptor) Object.defineProperty(globalThis, '$state', stateDescriptor)
  else Reflect.deleteProperty(globalThis, '$state')
})

/**
 * Getting to a build without the command palette (plan 016, S02): the
 * project panel's Devices row opens the Devices pane on Run app.
 */

describe('Run app entry points', () => {
  test('opening Run app opens the Devices pane already on Run app', () => {
    // WHY: the project panel row exists to skip the extra click.
    const opened: [string | undefined, string | undefined][] = []
    openRunApp({ openDevices: (sessionId?: string, serverId?: string) => opened.push([sessionId, serverId]) }, 'host-a', 's1')
    expect(opened).toEqual([['s1', 'host-a']])
    expect(deviceViewState.isShowingRunApp('host-a')).toBe(true)
    expect(deviceViewState.isShowingRunApp('host-b')).toBe(false)
  })
})

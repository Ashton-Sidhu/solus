import { describe, expect, test } from 'bun:test'
import { deviceViewState, openDeviceBuilds } from '@solus/workspace-ui/components/devices/lib/device-view-state.svelte'

/**
 * Getting to a build without the command palette (plan 016, S02): the
 * project panel's Devices row opens the Devices pane on Builds.
 */

describe('build entry points', () => {
  test('opening Builds opens the Devices pane already on Builds', () => {
    // WHY: the project panel row exists to skip the extra click.
    const opened: [string | undefined, string | undefined][] = []
    openDeviceBuilds({ openDevices: (sessionId?: string, serverId?: string) => opened.push([sessionId, serverId]) }, 'host-a', 's1')
    expect(opened).toEqual([['s1', 'host-a']])
    expect(deviceViewState.isShowingBuilds('host-a')).toBe(true)
    expect(deviceViewState.isShowingBuilds('host-b')).toBe(false)
  })
})

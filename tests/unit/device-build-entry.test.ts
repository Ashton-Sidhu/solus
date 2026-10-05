import { describe, expect, test } from 'bun:test'
import type { DeviceBuildRef } from '@solus/contracts/device-types'
import type { Message } from '@solus/contracts/types'
import { groupMessages } from '@solus/workspace-ui/components/conversation/lib/turns'
import { deviceViewState, openDeviceBuilds } from '@solus/workspace-ui/components/devices/lib/device-view-state.svelte'
import { TranscriptModel } from '../../apps/mobile/src/features/conversation/lib/transcript-model'

/**
 * Getting to a build without the command palette (plan 016, S02). The build
 * an agent hands over shows in the conversation where the person asked for
 * it, on every client, and its way in opens the Devices pane on Builds.
 */

const ref: DeviceBuildRef = { buildId: 'build_1', name: 'Demo.app', platform: 'ios', appId: 'dev.solus.demo', installedOn: 'Ash iPhone' }

describe('build entry points', () => {
  test('a handed-over build is its own transcript card, not folded into the prose', () => {
    const messages: Message[] = [
      { id: 'm1', role: 'assistant', content: '', deviceBuild: ref, timestamp: 1 },
      { id: 'm2', role: 'assistant', content: 'It is on your phone.', timestamp: 2 },
    ]
    expect(groupMessages(messages)).toEqual([
      { kind: 'device-build', message: messages[0] },
      { kind: 'assistant', message: messages[1] },
    ])
  })

  test('the mobile conversation shows the same build as a row', () => {
    const model = new TranscriptModel('s1')
    model.apply({ type: 'device_build_ready', build: ref })
    expect([...model.items.values()]).toEqual([{ kind: 'build', id: expect.any(String), build: ref }])
    expect(model.takeChanges().order).toBe(true)
  })

  test('opening Builds opens the Devices pane already on Builds', () => {
    // WHY: the card and the project panel row exist to skip the extra click.
    const opened: [string | undefined, string | undefined][] = []
    openDeviceBuilds({ openDevices: (sessionId?: string, serverId?: string) => opened.push([sessionId, serverId]) }, 'host-a', 's1')
    expect(opened).toEqual([['s1', 'host-a']])
    expect(deviceViewState.isShowingBuilds('host-a')).toBe(true)
    expect(deviceViewState.isShowingBuilds('host-b')).toBe(false)
  })
})

import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { asHostApi } from '@solus/client-core/host-api'
import { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import { HostFacts } from '@solus/client-core/host-facts'
import { serverConnections } from '@solus/client-core/server-connections'
import type { HostCapabilities, VoiceModelStatus } from '@solus/contracts/types'
import { Host } from '@solus/workspace-ui/contexts/hosts/host.svelte'

// docs/plans/host-model.md: the mic reads the voice facts of the host that
// transcribes for this client. On 2026-10-08 a desktop whose Run on host was a
// remote server lost its mic and ⌥⇧Space, because the gate read that server.

function hostWith(id: string, capabilities: HostCapabilities, status: VoiceModelStatus = { state: 'ready' }): Host {
  const facts = new HostFacts(id, {
    api: asHostApi({ serverGetCapabilities: async () => capabilities, voiceModelStatus: async () => status }),
    events: new HostEventSubscriber(),
  })
  return new Host(id, facts, () => [])
}

async function settle(host: Host): Promise<void> {
  void host.voiceModel
  await host.when('capabilities')
  await host.when('voiceModel').catch(() => {})
}

describe('voice on a host', () => {
  afterEach(() => mock.restore())

  // Only the desktop main process registers `voiceModelStatus`, so a client
  // talking to a standalone server can never transcribe there. The mic must be
  // absent, not a disabled button blaming a download that never started.
  test('a host without the voiceModel capability does not transcribe', async () => {
    const host = hostWith('server', { voiceModel: false })
    await settle(host)
    expect(host.transcribes).toBe(false)
    expect(host.voiceReady).toBe(false)
  })

  // A model that is still downloading is a different state: the host can
  // transcribe, so the mic stays and explains itself.
  test('a capable host keeps the mic while its model downloads', async () => {
    const host = hostWith('desktop', { voiceModel: true }, { state: 'downloading', receivedBytes: 1, totalBytes: 4 })
    await settle(host)
    expect(host.transcribes).toBe(true)
    expect(host.voiceStatus.state).toBe('downloading')
    expect(host.voiceProgressPct).toBe(25)
  })

  // Before the host answers, assume it transcribes: flashing the mic out of a
  // desktop composer on every boot is worse than the rare late hide.
  test('a host that has not answered keeps the mic', () => {
    const host = hostWith('desktop', { voiceModel: true })
    expect(host.transcribes).toBe(true)
    expect(host.voiceStatus.state).toBe('checking')
  })

  test('the desktop transcribes for its mic even when the Run on host cannot', async () => {
    const hostsById = new Map([
      ['local', hostWith('local', { voiceModel: true })],
      ['remote', hostWith('remote', { voiceModel: false })],
    ])
    spyOn(serverConnections, 'localServerId').mockImplementation(() => 'local')
    spyOn(serverConnections, 'runOnHostId').mockImplementation(() => 'remote')
    const { hosts } = await import('@solus/workspace-ui/contexts/hosts/hosts.svelte')
    spyOn(hosts, 'get').mockImplementation((serverId: string) => hostsById.get(serverId)!)
    const voiceHost = hosts.transcription!
    await settle(voiceHost)
    expect(voiceHost.id).toBe('local')
    expect(voiceHost.transcribes).toBe(true)
    expect(voiceHost.voiceReady).toBe(true)
  })
})

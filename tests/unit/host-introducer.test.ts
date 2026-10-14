import { describe, expect, test } from 'bun:test'
import type { HostIntroduction, IntroducedHostsSummary } from '@solus/contracts/host-api'
import { introduceHosts, type IntroducerHost } from '@solus/client-core/host-introducer'

// WHY: docs/plans/host-reach.md §4 — a device connected to two of a person's hosts
// introduces them, so the hosts reach each other with no pairing step. Each side gets
// the token the other issued, with the device it issued in return; hosts that already
// know each other are left alone, and a host the person forgot is never introduced again.

interface FakeHost extends IntroducerHost {
  accepted: Array<{ introduction: HostIntroduction; grantedDeviceId: string }>
}

function fakeHost(installationId: string, known: IntroducedHostsSummary = { hosts: [], refused: [] }, options: { cannotReach?: boolean } = {}): FakeHost {
  const accepted: FakeHost['accepted'] = []
  return {
    installationId,
    label: `Name ${installationId}`,
    accepted,
    api: {
      hostIntroductionsList: async () => known,
      hostIntroductionIssue: async (forHost) => ({ installationId, label: `Name ${installationId}`, urls: [`http://${installationId}:7777`], sessionToken: `token-from-${installationId}-for-${forHost.installationId}`, deviceId: `device-on-${installationId}` }),
      hostIntroductionAccept: async (args) => {
        if (options.cannotReach) throw new Error('cannot reach')
        accepted.push(args)
        return { ok: true as const }
      },
    },
  }
}

const knows = (...installationIds: string[]): IntroducedHostsSummary => ({ hosts: installationIds.map((installationId) => ({ installationId, label: installationId, url: '', introducedAt: 0 })), refused: [] })

describe('introducing a person\'s hosts', () => {
  test('each host keeps the token the other issued, with the device it issued in return', async () => {
    const mac = fakeHost('mac')
    const omarchy = fakeHost('omarchy')
    await introduceHosts([mac, omarchy])
    expect(mac.accepted).toEqual([{ introduction: expect.objectContaining({ installationId: 'omarchy', sessionToken: 'token-from-omarchy-for-mac' }), grantedDeviceId: 'device-on-mac' }])
    expect(omarchy.accepted).toEqual([{ introduction: expect.objectContaining({ installationId: 'mac', sessionToken: 'token-from-mac-for-omarchy' }), grantedDeviceId: 'device-on-omarchy' }])
  })

  test('hosts that already know each other are left alone; a half introduction is made again', async () => {
    const both = [fakeHost('mac', knows('omarchy')), fakeHost('omarchy', knows('mac'))]
    await introduceHosts(both)
    expect(both.flatMap((host) => host.accepted)).toEqual([])
    const half = [fakeHost('mac', knows('omarchy')), fakeHost('omarchy')]
    await introduceHosts(half)
    expect(half.map((host) => host.accepted.length)).toEqual([1, 1])
  })

  test('a host the person forgot on either side is never introduced again', async () => {
    const mac = fakeHost('mac', { hosts: [], refused: [{ installationId: 'omarchy', label: 'Omarchy' }] })
    const omarchy = fakeHost('omarchy')
    await introduceHosts([mac, omarchy])
    expect([mac.accepted, omarchy.accepted]).toEqual([[], []])
  })

  test('every pair of three hosts is introduced, and one failure does not stop the others', async () => {
    const hosts = [fakeHost('a', undefined, { cannotReach: true }), fakeHost('b'), fakeHost('c')]
    await introduceHosts(hosts)
    expect(hosts[1]!.accepted.map((entry) => entry.introduction.installationId).sort()).toEqual(['a', 'c'])
    expect(hosts[2]!.accepted.map((entry) => entry.introduction.installationId).sort()).toEqual(['a', 'b'])
  })
})

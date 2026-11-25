import { expect, test } from 'bun:test'
import type { HostApi } from '@solus/client-core/host-api'
import type { IntroducerHost } from '@solus/client-core/host-introducer'
import type { HostIntroduction, IntroducedHostsSummary } from '@solus/contracts/host-api'
import { hostMesh } from '@solus/server/execution/orchestration/host-mesh'
import type { HostTarget, RemoteHost } from '@solus/server/execution/orchestration/remote-hosts'

// WHY: docs/plans/host-reach.md §4.4. A person's machines reach each other with no
// step, even when no device reaches all of them: a host introduces the machines it
// holds as the owner (a pairing or an introduction). An account host is reached
// through the account plane, so it is not introduced.

const nobody: IntroducedHostsSummary = { hosts: [], refused: [] }

function fakeApi(installationId: string, accepted: string[]) {
  return {
    hostIntroductionsList: async () => nobody,
    hostIntroductionIssue: async (forHost: { installationId: string }): Promise<HostIntroduction> => ({
      installationId, label: installationId, urls: [`http://${installationId}:7777`], identityKey: `key-${installationId}`,
      sessionToken: `token-from-${installationId}-for-${forHost.installationId}`, deviceId: `device-on-${installationId}`,
    }),
    hostIntroductionAccept: async ({ introduction }: { introduction: HostIntroduction }) => {
      accepted.push(introduction.installationId)
      return { ok: true as const }
    },
  }
}

function target(installationId: string, source: HostTarget['source']): HostTarget {
  return { hostId: installationId, installationId, label: installationId, routes: [], source, connectionKey: `${source}:${installationId}`, credential: async () => 'token' }
}

test('a host introduces the machines it holds to each other and to itself, never an account host', async () => {
  const accepted = new Map<string, string[]>([['self', []], ['nas', []], ['laptop', []], ['cloud', []]])
  const self: IntroducerHost = { installationId: 'self', label: 'self', api: fakeApi('self', accepted.get('self')!) }
  const connected: string[] = []
  const mesh = hostMesh({
    self: () => self,
    targets: async () => [target('nas', 'paired'), target('laptop', 'introduced'), target('cloud', 'account')],
    connect: (held) => {
      connected.push(held.installationId)
      // SAFETY: the mesh calls only the three introduction methods, which the fake has.
      const api = fakeApi(held.installationId, accepted.get(held.installationId)!) as unknown as HostApi
      return { hostId: held.hostId, installationId: held.installationId, label: held.label, api, call: (_what, request) => request() } as RemoteHost
    },
  })
  mesh.run()
  await new Promise((resolve) => setTimeout(resolve, 10))

  expect(connected).toEqual(['nas', 'laptop'])
  expect(accepted.get('nas')!.sort()).toEqual(['laptop', 'self'])
  expect(accepted.get('laptop')!.sort()).toEqual(['nas', 'self'])
  expect(accepted.get('cloud')).toEqual([])
})

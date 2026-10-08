import { afterEach, expect, test } from 'bun:test'
import { asHostApi } from '@solus/client-core/host-api'
import type { IpcContext } from '@solus/contracts/types'
import { useGitSectionReads } from '@solus/workspace-ui/components/project-panel/lib/git-section-reads.svelte'

const runtime = globalThis as typeof globalThis & { $effect?: (effect: () => void | (() => void)) => void }
const previousEffect = runtime.$effect

afterEach(() => {
  if (previousEffect) runtime.$effect = previousEffect
  else delete runtime.$effect
})

test('hidden Git rows do not read the host, and closing them releases details', () => {
  const effects: Array<() => void | (() => void)> = []
  let cleanups: Array<void | (() => void)> = []
  runtime.$effect = (effect) => { effects.push(effect) }
  function update() {
    for (const cleanup of cleanups) cleanup?.()
    cleanups = effects.map((effect) => effect())
  }
  let active = false
  let cwd = '/repo'
  const probes: string[] = []
  const connections: string[] = []
  let subscriptions = 0
  const api = asHostApi({})
  useGitSectionReads({
    get active() { return active },
    get cwd() { return cwd },
    serverId: 'host-a', api, readiness: 'local-only',
    context: () => ({}) as IpcContext,
    repository: {
      refresh: async (_api, _serverId, path) => { probes.push(path); return null },
      refreshGithubConnection: async (_api, _serverId, _ctx, path) => { connections.push(path) },
    },
    environment: { watchDetails: () => { subscriptions++; return () => { subscriptions-- } } },
  })
  update()
  expect(probes).toEqual([])
  expect(connections).toEqual([])
  expect(subscriptions).toBe(0)
  active = true
  update()
  expect(probes).toEqual(['/repo'])
  expect(connections).toEqual(['/repo'])
  expect(subscriptions).toBe(1)
  active = false
  update()
  expect(subscriptions).toBe(0)
  active = true
  update()
  expect(probes).toEqual(['/repo'])
  expect(connections).toEqual(['/repo'])
  cwd = '/other-repo'
  update()
  expect(probes).toEqual(['/repo', '/other-repo'])
  expect(connections).toEqual(['/repo', '/other-repo'])
  for (const cleanup of cleanups) cleanup?.()
})

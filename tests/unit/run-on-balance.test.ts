import { describe, expect, test } from 'bun:test'
import type { HostBalancing } from '@solus/client-core/host-balance'
import type { ProjectRef } from '@solus/workspace-ui/contexts/projects/project-catalog'
import { NEW_CHAT_DIRECTORY } from '@solus/contracts/chat'
import type { RunConfig, RunLocation } from '@solus/contracts/types'
import { balanceCandidates } from '@solus/workspace-ui/components/servers/lib/run-on-balance'
import { sameStart } from '@solus/workspace-ui/contexts/workspace/draft-balancer'
import { adoptGit, chooseStart, folderLocation, openFolder } from '@solus/workspace-ui/contexts/workspace/run-location'

const balancing: HostBalancing = { enabled: true, preferences: {} }
const server = (id: string, change: object = {}) => ({ id, installationId: `install-${id}`, readiness: 'ready', ...change })
const run = (location: RunLocation) => ({ location }) as RunConfig
const checkout = (serverId: string, projectRoot: string) => ({ serverId, projectRoot }) as unknown as ProjectRef
const everyAgent = () => true

describe('balanceCandidates', () => {
  const project = run(folderLocation({ serverId: 'a', path: '/repo' }))

  test('lists hosts that hold the project, with the folder on each', () => {
    expect(balanceCandidates({ run: project, servers: [server('a'), server('b')], checkouts: [checkout('b', '/srv/repo')], balancing, runsAgent: everyAgent }))
      .toEqual([{ serverId: 'a', path: '/repo', preference: 'normal' }, { serverId: 'b', path: '/srv/repo', preference: 'normal' }])
  })

  test('a host that would need a clone is never a candidate: a clone is a choice a person makes', () => {
    const hosts = balanceCandidates({ run: project, servers: [server('a'), server('empty')], checkouts: [], balancing, runsAgent: everyAgent })
    expect(hosts.map((host) => host.serverId)).toEqual(['a'])
  })

  test('a chat can run on any host', () => {
    const chat = run(folderLocation({ serverId: 'a', path: NEW_CHAT_DIRECTORY }))
    const hosts = balanceCandidates({ run: chat, servers: [server('a'), server('b')], checkouts: [], balancing, runsAgent: everyAgent })
    expect(hosts.map((host) => [host.serverId, host.path])).toEqual([['a', NEW_CHAT_DIRECTORY], ['b', NEW_CHAT_DIRECTORY]])
  })

  test('leaves out Manual only, a host that is down, and a host without the agent', () => {
    const hosts = balanceCandidates({
      run: project,
      servers: [server('a'), server('manual'), server('down', { readiness: 'unreachable' }), server('noagent')],
      checkouts: [checkout('manual', '/r'), checkout('down', '/r'), checkout('noagent', '/r')],
      balancing: { enabled: true, preferences: { 'install-manual': 'manual' } },
      runsAgent: (serverId) => serverId !== 'noagent',
    })
    expect(hosts.map((host) => host.serverId)).toEqual(['a'])
  })

  test('leaves out a managed host whose compute is not ready', () => {
    const hosts = balanceCandidates({
      run: project,
      servers: [server('a'), server('managed', { uplink: { hostId: 'm', directoryUrl: 'x', kind: 'managed', managedState: 'provisioning' } })],
      checkouts: [checkout('managed', '/r')],
      balancing,
      runsAgent: everyAgent,
    })
    expect(hosts.map((host) => host.serverId)).toEqual(['a'])
  })
})

describe('sameStart', () => {
  const place = { serverId: 'a', path: '/repo' }
  const start = folderLocation(place)
  const git = { repoRoot: '/repo', branch: 'main', targetBranch: 'main' }

  test('a Git answer is not a choice', () => {
    expect(sameStart(start, adoptGit(start, place, git))).toBe(true)
    const asked = chooseStart(start, { kind: 'new-worktree' })
    expect(sameStart(asked, adoptGit(asked, place, git, { baseBranch: 'main' }))).toBe(true)
  })

  test('another host, a branch, and a worktree are choices', () => {
    const known = adoptGit(start, place, git)
    expect(sameStart(known, openFolder(known, { serverId: 'b', path: '/repo' }))).toBe(false)
    expect(sameStart(known, chooseStart(known, { kind: 'branch', git: { ...git, branch: 'feature' } }))).toBe(false)
    expect(sameStart(known, chooseStart(known, { kind: 'new-worktree' }))).toBe(false)
    expect(sameStart(known, chooseStart(known, { kind: 'worktree', path: '/repo/.w', branch: 'x' }))).toBe(false)
  })
})

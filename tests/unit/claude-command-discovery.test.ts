import { describe, expect, test } from 'bun:test'
import type { AgentSlashCommand } from '@solus/contracts/types'
import { ClaudeCommandDiscovery } from '@solus/server/execution/agents/claude/claude-command-discovery'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('ClaudeCommandDiscovery', () => {
  test('shares identical requests and serializes distinct subprocess discovery', async () => {
    const pending: Array<ReturnType<typeof deferred<AgentSlashCommand[]>>> = []
    let active = 0
    let maxActive = 0
    const targets: string[] = []
    const discovery = new ClaudeCommandDiscovery(async (target) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      targets.push(`${target.cwd}:${target.model}`)
      const request = deferred<AgentSlashCommand[]>()
      pending.push(request)
      try {
        return await request.promise
      } finally {
        active -= 1
      }
    }, 60_000)

    const first = discovery.get({ cwd: '/repo-a', model: 'opus', configDir: '/host/.claude' })
    const duplicate = discovery.get({ cwd: '/repo-a', model: 'opus', configDir: '/host/.claude' })
    const otherDirectory = discovery.get({ cwd: '/repo-b', model: 'opus', configDir: '/host/.claude' })
    const otherModel = discovery.get({ cwd: '/repo-a', model: 'sonnet', configDir: '/host/.claude' })

    await Promise.resolve()
    expect(targets).toEqual(['/repo-a:opus'])
    expect(first).toBe(duplicate)

    pending[0].resolve([{ name: 'first', description: '' }])
    await first
    await Promise.resolve()
    expect(targets).toEqual(['/repo-a:opus', '/repo-b:opus'])

    pending[1].resolve([{ name: 'second', description: '' }])
    await otherDirectory
    await Promise.resolve()
    expect(targets).toEqual(['/repo-a:opus', '/repo-b:opus', '/repo-a:sonnet'])

    pending[2].resolve([{ name: 'third', description: '' }])
    await otherModel
    expect(maxActive).toBe(1)
  })

  test('cache invalidation lets a fresh request survive an older failure', async () => {
    const pending: Array<ReturnType<typeof deferred<AgentSlashCommand[]>>> = []
    const discovery = new ClaudeCommandDiscovery(async () => {
      const request = deferred<AgentSlashCommand[]>()
      pending.push(request)
      return request.promise
    }, 60_000)

    const stale = discovery.get({ cwd: '/repo', model: 'opus', configDir: '/host/.claude' })
    await Promise.resolve()
    discovery.clear()
    const fresh = discovery.get({ cwd: '/repo', model: 'opus', configDir: '/host/.claude' })

    pending[0].reject(new Error('stale request failed'))
    await expect(stale).rejects.toThrow('stale request failed')
    await Promise.resolve()
    pending[1].resolve([{ name: 'fresh', description: '' }])

    expect(await fresh).toEqual([{ name: 'fresh', description: '' }])
    expect(discovery.get({ cwd: '/repo', model: 'opus', configDir: '/host/.claude' })).toBe(fresh)
  })

  test('each seat discovers its own commands: two people on one host never share a list', async () => {
    const loads: Array<{ configDir: string; seatHome: string | undefined }> = []
    const discovery = new ClaudeCommandDiscovery(async (target) => {
      loads.push({ configDir: target.configDir, seatHome: target.seat?.home })
      return [{ name: target.configDir === '/data/members/ada/.claude' ? 'grill-me' : 'host-skill', description: '' }]
    }, 60_000)

    const host = await discovery.get({ cwd: '/repo', model: 'opus', configDir: '/data/home/.claude' })
    const member = await discovery.get({ cwd: '/repo', model: 'opus', configDir: '/data/members/ada/.claude', seat: { home: '/run/solus-seats/claude/ada' } })

    expect(host.map((command) => command.name)).toEqual(['host-skill'])
    expect(member.map((command) => command.name)).toEqual(['grill-me'])
    expect(loads).toEqual([
      { configDir: '/data/home/.claude', seatHome: undefined },
      { configDir: '/data/members/ada/.claude', seatHome: '/run/solus-seats/claude/ada' },
    ])
  })
})

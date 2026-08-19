import { describe, expect, test } from 'bun:test'
import type { AgentSlashCommand } from '@solus/contracts/types'
import { ClaudeCommandDiscovery } from '@solus/server/agents/claude/claude-command-discovery'

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

    const first = discovery.get({ cwd: '/repo-a', model: 'opus' })
    const duplicate = discovery.get({ cwd: '/repo-a', model: 'opus' })
    const otherDirectory = discovery.get({ cwd: '/repo-b', model: 'opus' })
    const otherModel = discovery.get({ cwd: '/repo-a', model: 'sonnet' })

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

    const stale = discovery.get({ cwd: '/repo', model: 'opus' })
    await Promise.resolve()
    discovery.clear()
    const fresh = discovery.get({ cwd: '/repo', model: 'opus' })

    pending[0].reject(new Error('stale request failed'))
    await expect(stale).rejects.toThrow('stale request failed')
    await Promise.resolve()
    pending[1].resolve([{ name: 'fresh', description: '' }])

    expect(await fresh).toEqual([{ name: 'fresh', description: '' }])
    expect(discovery.get({ cwd: '/repo', model: 'opus' })).toBe(fresh)
  })
})

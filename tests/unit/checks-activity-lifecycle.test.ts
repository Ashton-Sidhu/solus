import { afterEach, describe, expect, jest, test } from 'bun:test'
import type { IpcContext } from '../../src/shared/types'
import type { Provider, RepoRef } from '../../src/main/providers/types'
import { SolusServer } from '../../src/main/server/server'
import { registerChecksHandlers } from '../../src/main/server/handlers/checks-handlers'

afterEach(() => jest.useRealTimers())

describe('PR checks client lifecycle', () => {
  test('rejects an activity lookup that finishes after disconnect and accepts the reconnect', async () => {
    const server = new SolusServer()
    const repo: RepoRef = { host: 'github.com', owner: 'owner', repo: 'repo' }
    const provider = {} as Provider
    let releaseLookup!: () => void
    const lookupGate = new Promise<void>((resolve) => { releaseLookup = resolve })
    let lookupCount = 0
    const lifecycle = registerChecksHandlers(server, {
      resolveReviewTarget: async () => {
        lookupCount += 1
        if (lookupCount === 1) await lookupGate
        return { repo, provider }
      },
    })
    const clientId = 'ws:device:instance'
    const ctx = {} as IpcContext

    lifecycle.handleClientConnected(clientId)
    const stale = server.handle('prChecksActivity', [ctx, false, false], { clientId })
    lifecycle.handleClientDisconnected(clientId)
    lifecycle.handleClientConnected(clientId)
    releaseLookup()
    await stale
    expect(lifecycle.stats()).toEqual({ connectedClients: 1, activities: 0, activeRepoKey: null })

    await server.handle('prChecksActivity', [ctx, false, false], { clientId })
    expect(lifecycle.stats()).toEqual({
      connectedClients: 1,
      activities: 1,
      activeRepoKey: null,
    })

    lifecycle.handleTransportClosed()
    expect(lifecycle.stats()).toEqual({ connectedClients: 0, activities: 0, activeRepoKey: null })
  })

  test('transport teardown cancels polling retained by connected clients', async () => {
    jest.useFakeTimers()
    jest.setSystemTime(0)
    let checksCalls = 0
    const provider = {
      review: {
        listPullRequests: async () => [],
        listChecks: async () => { checksCalls += 1; return [] },
      },
    } as unknown as Provider
    const server = new SolusServer()
    const lifecycle = registerChecksHandlers(server, {
      resolveReviewTarget: async () => ({
        repo: { host: 'github.com', owner: 'owner', repo: 'transport-close' },
        provider,
      }),
    })
    const clientId = 'ws:device:transport-close'

    lifecycle.handleClientConnected(clientId)
    await server.handle('prChecksActivity', [{} as IpcContext, true, true], { clientId })
    expect(lifecycle.stats().activeRepoKey).toBe('github.com/owner/transport-close')

    lifecycle.handleTransportClosed()
    jest.advanceTimersByTime(120_000)
    expect(checksCalls).toBe(0)
    expect(lifecycle.stats()).toEqual({ connectedClients: 0, activities: 0, activeRepoKey: null })
  })
})

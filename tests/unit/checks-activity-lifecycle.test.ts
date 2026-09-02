import { afterEach, describe, expect, jest, mock, test } from 'bun:test'
import { localOwnerCtx } from './helpers/handler-ctx'
import { Database } from 'bun:sqlite'
import type { IpcContext } from '@solus/contracts/types'
import type { Provider, RepoRef } from '@solus/server/providers/types'
import { SolusServer } from '@solus/server/server/server'
import { ClientEventRegistry } from '@solus/server/events/client-event-registry'
import { HostEventPublisher } from '@solus/server/events/host-event-publisher'

// The handler's default provider resolver reaches the production database
// module, which imports node:sqlite (absent under Bun's test runtime).
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

const { registerChecksHandlers } = await import('@solus/server/server/handlers/checks-handlers')

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
      events: new HostEventPublisher(new ClientEventRegistry()),
      resolveReviewTarget: async () => {
        lookupCount += 1
        if (lookupCount === 1) await lookupGate
        return { repo, provider }
      },
    })
    const clientId = 'ws:device:instance'
    const ctx = {} as IpcContext

    lifecycle.handleClientConnected(clientId)
    const stale = server.handle('prChecksActivity', [ctx, false, false], localOwnerCtx(clientId))
    lifecycle.handleClientDisconnected(clientId)
    lifecycle.handleClientConnected(clientId)
    releaseLookup()
    await stale
    expect(lifecycle.stats()).toEqual({ connectedClients: 1, activities: 0, activeRepoKey: null })

    await server.handle('prChecksActivity', [ctx, false, false], localOwnerCtx(clientId))
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
      events: new HostEventPublisher(new ClientEventRegistry()),
      resolveReviewTarget: async () => ({
        repo: { host: 'github.com', owner: 'owner', repo: 'transport-close' },
        provider,
      }),
    })
    const clientId = 'ws:device:transport-close'

    lifecycle.handleClientConnected(clientId)
    await server.handle('prChecksActivity', [{} as IpcContext, true, true], localOwnerCtx(clientId))
    expect(lifecycle.stats().activeRepoKey).toBe('github.com/owner/transport-close')

    lifecycle.handleTransportClosed()
    jest.advanceTimersByTime(120_000)
    expect(checksCalls).toBe(0)
    expect(lifecycle.stats()).toEqual({ connectedClients: 0, activities: 0, activeRepoKey: null })
  })

  test('concurrent activity reports publish one checks refresh', async () => {
    const server = new SolusServer()
    let finishChecks!: () => void
    const checksGate = new Promise<void>((resolve) => { finishChecks = resolve })
    let finishPublish!: () => void
    const published = new Promise<void>((resolve) => { finishPublish = resolve })
    let publishCount = 0
    const provider = {
      review: {
        listPullRequests: async () => [],
        listChecks: async () => {
          await checksGate
          return []
        },
      },
    } as unknown as Provider
    const lifecycle = registerChecksHandlers(server, {
      events: {
        publish: () => {
          publishCount += 1
          finishPublish()
          return 1
        },
      } as never,
      resolveReviewTarget: async () => ({
        repo: { host: 'github.com', owner: 'owner', repo: 'coalesced-refresh' },
        provider,
      }),
    })
    const firstClientId = 'ws:device:first'
    const secondClientId = 'ws:device:second'
    lifecycle.handleClientConnected(firstClientId)
    lifecycle.handleClientConnected(secondClientId)

    const first = server.handle(
      'prChecksActivity',
      [{} as IpcContext, true, true],
      localOwnerCtx(firstClientId),
    )
    const second = server.handle(
      'prChecksActivity',
      [{} as IpcContext, true, true],
      localOwnerCtx(secondClientId),
    )
    await Promise.resolve()
    finishChecks()
    await Promise.all([first, second])
    await published
    await Promise.resolve()

    expect(publishCount).toBe(1)
    lifecycle.handleTransportClosed()
  })
})

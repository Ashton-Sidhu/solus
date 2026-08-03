import { describe, expect, test } from 'bun:test'

;(globalThis as any).$state = <T>(value: T): T => value

const { MemoryRouteHistory, RouterStore } = await import('../../src/renderer/contexts/workspace/routing')

describe('workspace router', () => {
  test('router shortcut back and forward delegate to route history', () => {
    const history = new MemoryRouteHistory('#/chat/a')
    const router = new RouterStore(history)
    router.start()

    router.navigateToChat('b')
    router.navigateToSettings('tools')
    expect(router.current).toEqual({ name: 'settings', tab: 'tools' })

    router.back()
    expect(router.current).toEqual({ name: 'chat', tabId: 'b' })

    router.back()
    expect(router.current).toEqual({ name: 'chat', tabId: 'a' })

    router.forward()
    expect(router.current).toEqual({ name: 'chat', tabId: 'b' })
  })
})

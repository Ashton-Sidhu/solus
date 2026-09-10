import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { WsTransport } from '@solus/client-core/ws-transport'
import { createNoHostSolusApi } from '@solus/client-core/no-host-api'

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
const transports: WsTransport[] = []

afterEach(() => {
  for (const transport of transports.splice(0)) transport.destroy()
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
  else Reflect.deleteProperty(globalThis, 'document')
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
  else Reflect.deleteProperty(globalThis, 'window')
})

function transport() {
  const client = new WsTransport({ serverUrl: 'http://127.0.0.1:1', sessionToken: '' })
  transports.push(client)
  return client
}

describe('client window visibility', () => {
  test('web visibility follows the browser without issuing a host RPC', async () => {
    const state = { visibilityState: 'visible', hasFocus: () => false }
    Object.defineProperty(globalThis, 'document', { configurable: true, value: state })
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {} })
    const client = transport()
    const invoke = spyOn(client, 'invoke').mockResolvedValue(false)
    const api = client.buildSolusApi()
    // Losing keyboard focus does not mean the user cannot see the conversation.
    expect(await api.isVisible()).toBe(true)
    state.visibilityState = 'hidden'
    expect(await api.isVisible()).toBe(false)
    expect(invoke).not.toHaveBeenCalled()
  })

  test('hostless browser visibility resolves before any host is connected', async () => {
    const state = { visibilityState: 'hidden' }
    Object.defineProperty(globalThis, 'document', { configurable: true, value: state })
    const api = createNoHostSolusApi()
    expect(await api.isVisible()).toBe(false)
    state.visibilityState = 'visible'
    expect(await api.isVisible()).toBe(true)
  })

  test('desktop keeps its existing native-window visibility handler', async () => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { solusNative: {} } })
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { visibilityState: 'hidden' } })
    const client = transport()
    const invoke = spyOn(client, 'invoke').mockResolvedValue(true)
    expect(await client.buildSolusApi().isVisible()).toBe(true)
    expect(invoke).toHaveBeenCalledWith('isVisible', [])
  })
})

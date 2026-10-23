import { expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { requestLinuxScreenshot, screenshotPath, type PortalBus, type PortalCall } from '../../apps/desktop/src/main/capture/linux-screenshot'

function portal(code: number, uri = 'file:///tmp/a%20b.png', immediate = false) {
  const connection = Object.assign(new EventEmitter(), { stream: { end() {} } })
  let closed = false
  const bus: PortalBus = {
    connection,
    invoke(call: PortalCall, callback: (error: Error | null, value: string) => void) {
      if (call.member === 'AddMatch') { callback(null, ''); return }
      if (call.member === 'Close') { closed = true; callback(null, ''); return }
      const token = call.body?.[1]?.[0]?.[1]?.[1]
      const path = '/org/freedesktop/portal/desktop/request/test/' + token
      const emit = () => connection.emit('message', { type: 4, path, interface: 'org.freedesktop.portal.Request', member: 'Response', body: [code, [['uri', [[{ type: 's', child: [] }], [uri]]]]] })
      if (immediate) emit()
      callback(null, path)
      if (!immediate) queueMicrotask(emit)
    },
  }
  return { bus, connection, isClosed: () => closed }
}

test('subscribes before capture and decodes a portal file URI', async () => {
  const fake = portal(0, 'file:///tmp/a%20b.png', true)
  // The fake owns no real socket; only stream.end is used by the capture boundary.
  const result = await requestLinuxScreenshot(undefined, () => fake.bus)
  expect(result).toBe('/tmp/a b.png')
  expect(fake.connection.listenerCount('message')).toBe(0)
  expect(fake.isClosed()).toBe(true)
})
test('cancellation returns no attachment; denial reports a failure', async () => {
  for (const code of [1, 2]) {
    const fake = portal(code)
    const request = requestLinuxScreenshot(undefined, () => fake.bus)
    if (code === 1) expect(await request).toBeNull()
    else await expect(request).rejects.toThrow('could not take')
    expect(fake.connection.listenerCount('message')).toBe(0)
  }
})
test('refuses remote file hosts and non-file portal results', () => {
  expect(() => screenshotPath('https://example.com/image.png')).toThrow()
  expect(() => screenshotPath('file://other-host/image.png')).toThrow()
})


test('shutdown abort closes a pending portal request', async () => {
  const fake = portal(0)
  const controller = new AbortController()
  const request = requestLinuxScreenshot(controller.signal, () => fake.bus)
  controller.abort()
  await expect(request).rejects.toThrow('interrupted')
  expect(fake.isClosed()).toBe(true)
  expect(fake.connection.listenerCount('message')).toBe(0)
  expect(() => fake.connection.emit('error', new Error('socket closed'))).not.toThrow()
})

test('a missing portal service reports an error; a silent service reaches its deadline', async () => {
  for (const available of [false, true]) {
    const connection = Object.assign(new EventEmitter(), { stream: { end() {} } })
    const bus: PortalBus = { connection, invoke(call, callback) {
      if (!available) callback(new Error('ServiceUnknown'), '')
      else if (call.member === 'AddMatch') callback(null, '')
      else callback(null, '/org/freedesktop/portal/desktop/request/test/pending')
    } }
    await expect(requestLinuxScreenshot(undefined, () => bus, 0)).rejects.toThrow(available ? 'did not respond' : 'unavailable')
    expect(connection.listenerCount('message')).toBe(0)
  }
})

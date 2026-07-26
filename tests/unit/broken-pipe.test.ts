import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'events'
import { installBrokenPipeGuard } from '../../src/main/broken-pipe'

describe('development console pipe', () => {
  test('treats an asynchronous EPIPE as normal launcher shutdown', () => {
    const stream = new EventEmitter()
    const guard = installBrokenPipeGuard(stream)
    let writes = 0

    stream.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    guard.write(() => { writes++ })

    expect(guard.isBroken).toBe(true)
    expect(writes).toBe(0)
  })

  test('suppresses a synchronous EPIPE and stops later writes', () => {
    const stream = new EventEmitter()
    const guard = installBrokenPipeGuard(stream)
    let writes = 0

    guard.write(() => {
      throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
    })
    guard.write(() => { writes++ })

    expect(guard.isBroken).toBe(true)
    expect(writes).toBe(0)
  })
})

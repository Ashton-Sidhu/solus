import { describe, expect, test } from 'bun:test'
import { BrowserFrameChannel } from '@solus/server/browser/browser-frame-channel'
import type { BrowserFrameHeader } from '@solus/contracts/browser-types'

/**
 * The frame channel is the server half of the binary side-channel. These tests
 * encode the two rules that keep it cheap: a frame reaches only the clients
 * named for it (never a broadcast), and a client that unregistered stops
 * receiving — otherwise a disconnected phone keeps paying for pixels nobody sees.
 */

const HEADER: BrowserFrameHeader = { browserPageId: 'browser_1', seq: 1 }

function received() {
  const frames: { clientId: string; header: BrowserFrameHeader; bytes: number }[] = []
  return {
    frames,
    delivery: (clientId: string) => (header: BrowserFrameHeader, data: Uint8Array) => {
      frames.push({ clientId, header, bytes: data.byteLength })
    },
  }
}

describe('browser frame channel', () => {
  test('a frame reaches only the clients it names, never every client', () => {
    // WHY: frames are the one thing on the wire that must not broadcast — a page
    // is only ever wanted by the panes showing it.
    const channel = new BrowserFrameChannel()
    const sink = received()
    channel.register('a', sink.delivery('a'))
    channel.register('b', sink.delivery('b'))

    channel.publish(['a'], HEADER, new Uint8Array([1, 2, 3]))

    expect(sink.frames.map((f) => f.clientId)).toEqual(['a'])
    expect(sink.frames[0]?.bytes).toBe(3)
  })

  test('an unregistered client stops receiving', () => {
    // WHY: this is the expiry path. A client whose connection died must not keep
    // a guest painting into a delivery that goes nowhere.
    const channel = new BrowserFrameChannel()
    const sink = received()
    const stop = channel.register('a', sink.delivery('a'))

    stop()
    channel.publish(['a'], HEADER, new Uint8Array([1]))

    expect(sink.frames).toHaveLength(0)
  })

  test('a delivery that throws does not stop the others', () => {
    // WHY: one wedged client must not take down the frame fan-out for the rest.
    const channel = new BrowserFrameChannel()
    const sink = received()
    channel.register('bad', () => { throw new Error('socket gone') })
    channel.register('good', sink.delivery('good'))

    channel.publish(['bad', 'good'], HEADER, new Uint8Array([9]))

    expect(sink.frames.map((f) => f.clientId)).toEqual(['good'])
  })
})

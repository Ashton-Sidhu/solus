import { describe, expect, test } from 'bun:test'
import { BrowserFrameSubscriber } from '@solus/client-core/browser-frame-subscriber'

/**
 * The client half of the frame side-channel. It routes raw JPEG bytes to
 * whichever streamed surface is showing that page, and normalizes the wire
 * shape — a header that must be validated, and bytes that arrive as an
 * ArrayBuffer (browser) or a Buffer view (node).
 */

describe('browser frame subscriber', () => {
  test('routes a frame only to the surface watching that page', () => {
    // WHY: two panes can stream two pages down one connection; a frame for one
    // must not paint the other.
    const subscriber = new BrowserFrameSubscriber()
    const one: number[] = []
    const two: number[] = []
    subscriber.subscribe('browser_1', (header) => one.push(header.seq))
    subscriber.subscribe('browser_2', (header) => two.push(header.seq))

    subscriber.receive({ browserPageId: 'browser_1', seq: 7 }, new ArrayBuffer(4))

    expect(one).toEqual([7])
    expect(two).toEqual([])
  })

  test('normalizes a Buffer view to a standalone ArrayBuffer', () => {
    // WHY: socket.io delivers node binary as a Buffer view over a shared pool;
    // handing that straight to `createImageBitmap` would decode neighbouring
    // frames' bytes. The subscriber copies out exactly this frame.
    const subscriber = new BrowserFrameSubscriber()
    let seen: ArrayBuffer | null = null
    subscriber.subscribe('browser_1', (_header, data) => { seen = data })

    const backing = new Uint8Array([0, 1, 2, 3, 4, 5])
    const view = backing.subarray(1, 4)
    subscriber.receive({ browserPageId: 'browser_1', seq: 1 }, view)

    expect(seen).toBeInstanceOf(ArrayBuffer)
    expect(seen ? new Uint8Array(seen) : null).toEqual(new Uint8Array([1, 2, 3]))
  })

  test('drops a frame with a malformed header rather than throwing', () => {
    // WHY: the header is wire input. A bad one is ignored, not a crash in the
    // socket handler.
    const subscriber = new BrowserFrameSubscriber()
    let called = false
    subscriber.subscribe('browser_1', () => { called = true })

    // `JSON.parse` returns `any`, which is how Socket.IO's untyped frame args
    // reach `receive` — so this feeds the runtime validation the wire junk it
    // exists to drop (a header with no browserPageId, then non-buffer bytes)
    // without a type assertion the parameter types would otherwise need.
    subscriber.receive(JSON.parse('{"seq":1}'), new ArrayBuffer(1))
    subscriber.receive({ browserPageId: 'browser_1', seq: 1 }, JSON.parse('"not-bytes"'))

    expect(called).toBe(false)
  })

  test('an unsubscribed surface stops receiving', () => {
    const subscriber = new BrowserFrameSubscriber()
    const seqs: number[] = []
    const off = subscriber.subscribe('browser_1', (header) => seqs.push(header.seq))

    subscriber.receive({ browserPageId: 'browser_1', seq: 1 }, new ArrayBuffer(1))
    off()
    subscriber.receive({ browserPageId: 'browser_1', seq: 2 }, new ArrayBuffer(1))

    expect(seqs).toEqual([1])
  })
})

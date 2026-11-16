import { describe, expect, test } from 'bun:test'
import ts from 'typescript'
import { readFileSync } from 'node:fs'
import { DeviceVideoDecoder, framePlacement } from '@solus/client-core/device-video'
import { DeviceInputGate } from '../../apps/mobile/src/features/devices/device-input-gate'
import { runInNewContext } from 'node:vm'
import type { DeviceVideoPacket } from '@solus/client-core/device-hub-stream'

// Run the real WebView script with a silent H.264 decoder and a hub that only
// sends the cached bootstrap JPEG. A native canvas is not needed for this race.
const compiled = ts.transpileModule(readFileSync(new URL('../../apps/mobile/src/features/devices/device-stream.browser.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

describe('native device stream startup', () => {
  function harness() {
    const streams: { format: string; closed: boolean; packet: (packet: DeviceVideoPacket, data: Uint8Array) => void }[] = []
    const timers: { callback: () => void; ms: number; cancelled: boolean }[] = []
    const events: { type: string; status?: string }[] = []
    let deliverVideo: ((frame: { displayWidth: number; displayHeight: number; close(): void }) => void) | null = null
    class Hub {
      readonly state: typeof streams[number]
      constructor(options: { format: string; onPacket: typeof streams[number]['packet'] }) {
        this.state = { format: options.format, packet: options.onPacket, closed: false }
        streams.push(this.state)
      }
      start() {}
      close() { this.state.closed = true }
      send() { return Promise.resolve() }
      requestKeyframe() {}
    }
    class Element {
      style = {}
      width = 0
      height = 0
      tabIndex = 0
      append() {}
      setAttribute() {}
      addEventListener() {}
      replaceChildren() {}
      getContext() { return { setTransform() {}, drawImage() {}, resetTransform() {} } }
    }
    const context = {
      document: { documentElement: new Element(), body: new Element(), createElement: () => new Element() },
      ReactNativeWebView: { postMessage: (message: string) => events.push(JSON.parse(message)) },
      addEventListener() {},
      setTimeout: (callback: () => void, ms: number) => { const timer = { callback, ms, cancelled: false }; timers.push(timer); return timer },
      clearTimeout: (timer: typeof timers[number]) => { timer.cancelled = true },
      require: (name: string) => {
        if (name === '@solus/client-core/device-hub-stream') return { DeviceHubStream: Hub }
        if (name === './device-input-gate') return { DeviceInputGate }
        if (name === '@solus/client-core/device-video') return { DeviceVideoDecoder, framePlacement, browserVideoCodecs: () => ({
          createDecoder: (init: { output: NonNullable<typeof deliverVideo> }) => {
            deliverVideo = init.output
            return { state: 'configured', decodeQueueSize: 0, configure() {}, decode() {}, close() {} }
          },
          isConfigSupported: async () => ({ supported: true }), createChunk: () => ({ type: 'key' }),
        }) }
        throw new Error(`Unexpected viewer dependency: ${name}`)
      },
      Blob, Uint8Array,
      createImageBitmap: async () => ({ width: 100, height: 200, close() {} }),
      exports: { start: (_configuration: { platform: string; kind: string; colors: { background: string; muted: string } }) => {}, stop: () => {} },
    }
    runInNewContext('globalThis.window = globalThis;\n' + compiled, context)
    context.exports.start({ platform: 'ios', kind: 'local', colors: { background: '#fff', muted: '#888' } })
    return { streams, timers, events, stop: context.exports.stop, video: () => deliverVideo?.({ displayWidth: 100, displayHeight: 200, close() {} }) }
  }

  test('a cached JPEG does not cancel fallback when H.264 never produces a live frame', async () => {
    const view = harness()
    view.streams[0]!.packet({ kind: 'seed', streamGeneration: 0 }, new Uint8Array([1]))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(view.events).toContainEqual({ type: 'status', status: 'streaming' })
    const deadline = view.timers.find((timer) => timer.ms === 8_000)!
    expect(deadline.cancelled).toBe(false)
    deadline.callback()
    expect(view.streams.map((stream) => stream.format)).toEqual(['h264', 'jpeg'])
    expect(view.streams[0]!.closed).toBe(true)
    view.stop()
  })

  test('a live decoded video frame cancels fallback', async () => {
    const view = harness()
    view.streams[0]!.packet({ kind: 'config', streamGeneration: 0 }, new Uint8Array())
    await new Promise((resolve) => setTimeout(resolve, 0))
    view.video()
    expect(view.timers.find((timer) => timer.ms === 8_000)?.cancelled).toBe(true)
    expect(view.streams).toHaveLength(1)
    view.stop()
  })

  test('closing the viewer cancels its pending fallback', () => {
    const view = harness()
    view.stop()
    expect(view.timers.find((timer) => timer.ms === 8_000)?.cancelled).toBe(true)
    expect(view.streams[0]!.closed).toBe(true)
  })
})

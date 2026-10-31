import { DeviceHubStream } from '@solus/client-core/device-hub-stream'
import { cloudDeviceVideo } from '@solus/client-core/device-webrtc'
import { DeviceVideoDecoder, browserVideoCodecs, framePlacement } from '@solus/client-core/device-video'
import type { DeviceInput, DeviceScreenConfig } from '@solus/contracts/device-types'

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage(message: string): void }
    solusDevice: {
      start(platform: 'ios' | 'android', kind: 'local' | 'ssh' | 'eas' | 'simlock'): void
      url(requestId: number, url: string | null): void
      input(input: DeviceInput): void
      enabled(value: boolean): void
    }
  }
}
let requestId = 0
let mayInteract = false
let hub: DeviceHubStream | null = null
let end: (() => void) | null = null
const urls = new Map<number, { resolve: (url: string) => void; reject: (error: Error) => void }>()
function post(message: { kind: 'url'; requestId: number } | { kind: 'status'; text: string }) { window.ReactNativeWebView?.postMessage(JSON.stringify(message)) }
function openUrl(): Promise<string> {
  return new Promise((resolve, reject) => {
    const id = ++requestId
    urls.set(id, { resolve, reject })
    post({ kind: 'url', requestId: id })
    setTimeout(() => { if (urls.delete(id)) reject(new Error('The host did not answer.')) }, 15_000)
  })
}
function send(input: DeviceInput) { if (mayInteract) void hub?.send([input]).catch(() => post({ kind: 'status', text: 'Device input failed. Take control again.' })) }
window.solusDevice = {
  enabled(value) { mayInteract = value },
  url(id, url) { const pending = urls.get(id); urls.delete(id); if (url) pending?.resolve(url); else pending?.reject(new Error('Cannot open the device stream.')) },
  input: send,
  start(platform, kind) {
    end?.()
    const node = document.querySelector('canvas')
    const canvas = node instanceof HTMLCanvasElement ? node : null
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    let screen: DeviceScreenConfig | null = null
    const paint = (source: CanvasImageSource, width: number, height: number) => {
      const placement = framePlacement(screen, width, height)
      if (canvas.width !== placement.width || canvas.height !== placement.height) { canvas.width = placement.width; canvas.height = placement.height }
      context.setTransform(...placement.transform); context.drawImage(source, 0, 0, width, height); context.resetTransform()
    }
    let format: 'h264' | 'jpeg' = browserVideoCodecs() || platform === 'android' || kind === 'simlock' ? 'h264' : 'jpeg'
    let videoStream: DeviceHubStream | null = null
    const decoder = new DeviceVideoDecoder({
      // SAFETY: the browser decoder presents only VideoFrames or ImageBitmaps, both canvas sources.
      present: (source, width, height) => paint(source as CanvasImageSource, width, height),
      screen: (value) => { screen = value },
      needsKeyframe: () => (videoStream ?? hub)?.requestKeyframe(),
      status: (status) => {
        if (status.kind === 'unsupported' && platform === 'ios' && kind !== 'simlock' && format === 'h264') { format = 'jpeg'; startVideo(); return }
        post({ kind: 'status', text: status.kind === 'streaming' ? '' : status.kind === 'ended' ? status.detail : status.kind === 'unsupported' ? 'This device cannot decode the video.' : 'Connecting…' })
      },
    }, browserVideoCodecs(), (blob) => createImageBitmap(blob))
    function startVideo() {
      videoStream?.close()
      videoStream = new DeviceHubStream({ platform, format, serveSimOnly: kind === 'simlock', openUrl, onPacket: (packet, data) => decoder.push(packet, data) })
      videoStream.start()
    }
    hub = new DeviceHubStream({ platform, format, serveSimOnly: kind === 'simlock', video: false, openUrl, onPacket: (packet, data) => decoder.push(packet, data) })
    hub.start()
    const stopCloud = kind === 'eas' ? cloudDeviceVideo({ openUrl, present: paint, status: (status, detail) => post({ kind: 'status', text: status === 'streaming' ? '' : detail ?? 'Connecting…' }), fallback: startVideo }) : null
    if (kind !== 'eas') startVideo()
    end = () => { stopCloud?.(); hub?.close(); videoStream?.close(); decoder.close() }
  },
}
const canvas = document.querySelector('canvas')
let pressed = false
function point(event: PointerEvent) {
  const rect = canvas!.getBoundingClientRect()
  return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) }
}
canvas?.addEventListener('pointerdown', (event) => {
  if (!(event instanceof PointerEvent) || !mayInteract) return
  pressed = true; canvas.setPointerCapture(event.pointerId); send({ kind: 'pointer', phase: 'down', ...point(event) })
})
canvas?.addEventListener('pointermove', (event) => { if (pressed && event instanceof PointerEvent) send({ kind: 'pointer', phase: 'move', ...point(event) }) })
for (const type of ['pointerup', 'pointercancel']) canvas?.addEventListener(type, (event) => {
  if (!pressed || !(event instanceof PointerEvent)) return
  pressed = false; send({ kind: 'pointer', phase: type === 'pointerup' ? 'up' : 'cancel', ...point(event) })
})
window.addEventListener('pagehide', () => { end?.(); end = null })
// Keep this entry free of renderer stores and native APIs; only the small message bridge crosses it.

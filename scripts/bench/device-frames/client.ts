/**
 * The renderer side: the real client transport receiving device frames. With
 * BUSY_PERCENT set, its event loop is busy that share of every 16 ms, as a
 * renderer painting a heavy workspace would be.
 */
import { WsTransport } from '@solus/client-core/ws-transport'

const [url, warmupArg, durationArg, busyArg] = process.argv.slice(2)
const warmupMs = Number(warmupArg)
const durationMs = Number(durationArg)
const busyPercent = Number(busyArg ?? 0)

const transport = new WsTransport({ serverUrl: url!, sessionToken: '' })
let measuring = false
const latencies: number[] = []
let frames = 0
let keys = 0
let bytes = 0
let lastAt = 0
let maxGap = 0
transport.deviceFrames.subscribe('bench', 'emu', (header, data) => {
  if (header.kind !== 'key' && header.kind !== 'delta') return
  const now = performance.timeOrigin + performance.now()
  if (!measuring) { lastAt = now; return }
  frames++
  if (header.kind === 'key') keys++
  bytes += data.byteLength
  if (header.timestamp) latencies.push(now - header.timestamp / 1000)
  if (lastAt) maxGap = Math.max(maxGap, now - lastAt)
  lastAt = now
})
transport.start()

if (busyPercent > 0) {
  setInterval(() => {
    const until = performance.now() + (16 * busyPercent) / 100
    while (performance.now() < until) { /* busy */ }
  }, 16)
}

setTimeout(() => {
  measuring = true
  const cpu = process.cpuUsage()
  setTimeout(() => {
    measuring = false
    const used = process.cpuUsage(cpu)
    const last = latencies.at(-1)
    const sorted = [...latencies].sort((a, b) => a - b)
    const at = (q: number) => +(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? NaN).toFixed(0)
    const seconds = durationMs / 1000
    console.error(JSON.stringify({
      client: {
        fps: +(frames / seconds).toFixed(1),
        keyframes: keys,
        receivedMbps: +((bytes * 8) / seconds / 1e6).toFixed(2),
        latencyP50Ms: at(0.5),
        latencyP95Ms: at(0.95),
        latencyMaxMs: at(1),
        latencyLastMs: +(last ?? NaN).toFixed(0),
        maxFreezeMs: +maxGap.toFixed(0),
        cpuPercentOfCore: +(((used.user + used.system) / 1000 / durationMs) * 100).toFixed(1),
      },
    }))
    process.exit(0)
  }, durationMs)
}, warmupMs)

/**
 * The host side, as the Electron main process runs it: the real Socket.IO
 * transport, frame channel and device link, reading the stand-in hub.
 */
import { createServer } from 'node:http'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { SolusServer } from '@solus/server/transport/server'
import { ClientEventRegistry } from '@solus/server/transport/events/client-event-registry'
import { attachWebSocketTransport } from '@solus/server/transport/websocket'
import { DeviceFrameChannel } from '@solus/server/devices/device-frame-channel'
import { DeviceStreams } from '@solus/server/devices/device-streams'
import { loopbackUpstream } from '@solus/server/devices/device-upstream'

const [portArg, hubPortArg, warmupArg, durationArg] = process.argv.slice(2)
const warmupMs = Number(warmupArg)
const durationMs = Number(durationArg)
const channel = new DeviceFrameChannel()
const streams = new DeviceStreams(channel, loopbackUpstream)
const target = { deviceHostId: 'bench', deviceId: 'emu', platform: 'android' as const, hubOrigin: `http://127.0.0.1:${hubPortArg}` }

let sent = 0
let sentBytes = 0
const originalSend = channel.send.bind(channel)
channel.send = (clientId, header, data) => {
  if (header.kind === 'key' || header.kind === 'delta') { sent++; sentBytes += data.byteLength }
  return originalSend(clientId, header, data)
}

const http = createServer()
const transport = attachWebSocketTransport(http, new SolusServer(), {
  clientEvents: new ClientEventRegistry(),
  deviceFrames: channel,
  requireAuth: false,
  onClientConnected: ({ clientId }) => {
    streams.subscribe(clientId, target, 'h264')
    setTimeout(measure, warmupMs)
  },
})
http.listen(Number(portArg), process.env.SERVER_HOST ?? '127.0.0.1', () => console.log('ready'))

function measure() {
  const delay = monitorEventLoopDelay({ resolution: 1 })
  delay.enable()
  const cpu = process.cpuUsage()
  const elu = performance.eventLoopUtilization()
  const sent0 = sent
  const raw = ([...transport.sessions.values()][0]?.socket.conn.transport as unknown as { socket?: { _extensions?: object } } | undefined)?.socket
  const bytes0 = sentBytes
  setTimeout(() => {
    const used = process.cpuUsage(cpu)
    const seconds = durationMs / 1000
    console.error(JSON.stringify({
      server: {
        deflateNegotiated: !!raw?._extensions && 'permessage-deflate' in raw._extensions,
        cpuPercentOfCore: +(((used.user + used.system) / 1000 / durationMs) * 100).toFixed(1),
        eventLoopUtilization: +performance.eventLoopUtilization(elu).utilization.toFixed(3),
        loopDelayP99Ms: +(delay.percentile(99) / 1e6).toFixed(1),
        loopDelayMaxMs: +(delay.max / 1e6).toFixed(1),
        videoPacketsSentPerSec: +((sent - sent0) / seconds).toFixed(1),
        sentMbps: +(((sentBytes - bytes0) * 8) / seconds / 1e6).toFixed(2),
      },
    }))
    process.exit(0)
  }, durationMs)
}

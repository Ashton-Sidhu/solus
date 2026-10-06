/**
 * A stand-in for serve-emu: streams a real H.264 fixture as SEMU packets at
 * 60 fps on any WebSocket path, and jumps to the next IDR on `reset-video`.
 */
import { readFileSync } from 'node:fs'
import WebSocket from 'ws'

const [fixturePath, portArg] = process.argv.slice(2)
const bytes = readFileSync(fixturePath!)
const units: { data: Buffer; isKey: boolean }[] = []
const starts: number[] = []
for (let i = 0; i + 4 < bytes.length; i++) {
  if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 0 && bytes[i + 3] === 1 && (bytes[i + 4]! & 0x1f) === 9) starts.push(i)
}
for (let s = 0; s < starts.length; s++) {
  const data = bytes.subarray(starts[s], starts[s + 1] ?? bytes.length)
  let isKey = false
  for (let i = 0; i + 4 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1 && (data[i + 3]! & 0x1f) === 5) { isKey = true; break }
  }
  units.push({ data, isKey })
}
// Start on a keyframe.
const firstKey = units.findIndex((unit) => unit.isKey)

const server = new WebSocket.Server({ port: Number(portArg) })
server.on('connection', (socket) => {
  let index = firstKey
  let keyRequests = 0
  socket.on('message', (message) => {
    if (String(message).includes('reset-video')) {
      keyRequests++
      const next = units.findIndex((unit, i) => i > index && unit.isKey)
      index = next < 0 ? firstKey : next
    }
  })
  const started = performance.now()
  let frame = 0
  const tick = () => {
    if (socket.readyState !== WebSocket.OPEN) return
    const unit = units[index]!
    const header = Buffer.alloc(16)
    header.writeUInt32BE(0x53454d55, 0)
    header.writeUInt8(1, 4)
    header.writeUInt8(unit.isKey ? 1 : 0, 5)
    header.writeBigUInt64BE(BigInt(Math.round((performance.timeOrigin + performance.now()) * 1000)), 8)
    socket.send(Buffer.concat([header, unit.data]))
    index = index + 1 >= units.length ? firstKey : index + 1
    frame++
    setTimeout(tick, Math.max(0, started + frame * (1000 / 60) - performance.now()))
  }
  tick()
  socket.on('close', () => console.error(JSON.stringify({ hub: { framesSent: frame, keyRequests } })))
})
console.log('ready')

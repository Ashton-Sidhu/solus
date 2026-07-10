import { WebSocketServer, WebSocket } from 'ws'
import type { Server as HttpServer } from 'http'
import type { IncomingMessage } from 'http'
import { randomBytes } from 'crypto'
import type { SolusServer } from '../server/server'
import { RPC_TOPICS } from '../../shared/rpc'
import type { RpcTopic } from '../../shared/rpc'
import { verifySessionToken } from '../server/auth'
import { createLogger } from '../logger'

const log = createLogger('main', 'ws-transport')
const RESUME_WAIT_MS = 2_000
const WS_BUFFERED_AMOUNT_LIMIT = 8 * 1024 * 1024

interface WsRequest {
  id: string
  method: string
  args?: unknown[]
}

interface WsResume {
  type: 'resume'
  /** Per-topic last-seen seq for replay. */
  lastSeqByTopic?: Partial<Record<RpcTopic, number>>
}

interface ClientSession {
  id: string
  socket: WebSocket
  deviceId: string | null
  deviceLabel: string
  connectedAt: number
  topicUnsubs: Array<() => void>
}

/**
 * Mounts the WebSocket transport on the given HTTP server at `/ws`. Each
 * connection authenticates with a `Bearer <sessionToken>` Authorization
 * header (or `?token=` query for clients that can't set headers, e.g.
 * the browser WebSocket constructor).
 *
 * Authentication is enforced when `requireAuth` is true (default). Set false
 * to allow loopback-only development without paired devices.
 *
 * Wire format (JSON, line-delimited frames):
 *
 *   client → server:  { id, method, args }              (request)
 *                     { type: "resume", lastSeqByTopic } (resume on reconnect)
 *
 *   server → client:  { id, result }                     (response)
 *                     { id, error: { message } }         (response error)
 *                     { type: "event", topic, seq, payload }  (push)
 */
export function attachWebSocketTransport(
  http: HttpServer,
  server: SolusServer,
  opts: { requireAuth?: boolean | (() => boolean) } = {}
): { close: () => void; sessions: Map<string, ClientSession> } {
  const requireAuth = () => typeof opts.requireAuth === 'function' ? opts.requireAuth() : (opts.requireAuth ?? true)
  const wss = new WebSocketServer({ noServer: true })
  const sessions = new Map<string, ClientSession>()

  http.on('upgrade', (req, socket, head) => {
    if (!req.url || !req.url.startsWith('/ws')) return

    const auth = parseAuth(req)
    let deviceId: string | null = null
    let deviceLabel = 'Web'

    if (requireAuth()) {
      if (!auth) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
      const verified = verifySessionToken(auth)
      if (!verified) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
      deviceId = verified.deviceId
      deviceLabel = verified.deviceLabel
    } else if (auth) {
      const verified = verifySessionToken(auth)
      if (verified) {
        deviceId = verified.deviceId
        deviceLabel = verified.deviceLabel
      }
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const id = randomBytes(8).toString('hex')
      const session: ClientSession = {
        id,
        socket: ws,
        deviceId,
        deviceLabel,
        connectedAt: Date.now(),
        topicUnsubs: [],
      }
      sessions.set(id, session)
      server.broadcast('presence', { type: 'connect', id, deviceLabel, deviceId })
      const clientId = `ws:${id}`
      let replayInProgress = false
      let liveEventsPaused = true
      const liveBuffer: string[] = []
      let resumeTimer: ReturnType<typeof setTimeout>
      const flushLiveBuffer = () => {
        if (!liveEventsPaused) return
        liveEventsPaused = false
        clearTimeout(resumeTimer)
        for (const frame of liveBuffer.splice(0)) sendRaw(ws, frame)
      }
      const deliverEventFrame = (frame: string) => {
        if (replayInProgress) {
          sendRaw(ws, frame)
        } else if (liveEventsPaused) {
          liveBuffer.push(frame)
        } else {
          sendRaw(ws, frame)
        }
      }
      resumeTimer = setTimeout(() => {
        flushLiveBuffer()
        send(ws, { type: 'event', topic: 'seq-watermark', seq: 0, payload: [server.getSeqWatermark()] })
      }, RESUME_WAIT_MS)

      // Subscribe to every topic; payloads are pushed as soon as they fire.
      // Serialize the frame once per broadcast (eventFrame) and reuse it across
      // every connected socket instead of re-stringifying per client.
      for (const topic of RPC_TOPICS) {
        const unsub = server.subscribe(topic, (payload, seq) => {
          deliverEventFrame(eventFrame(topic, seq, payload as unknown[]))
        })
        session.topicUnsubs.push(unsub)
      }
      const unsubDirect = server.registerDirectClient(clientId, (topic, payload, seq) => {
        deliverEventFrame(typeof seq === 'number'
          ? eventFrame(topic, seq, payload as unknown[])
          : JSON.stringify({ type: 'event', topic, payload }))
      })
      session.topicUnsubs.push(unsubDirect)

      // Heartbeat — drop stale clients within 45s.
      let alive = true
      ws.on('pong', () => { alive = true })
      const interval = setInterval(() => {
        if (!alive) {
          log.warn(`ws session ${id} stale, terminating`)
          ws.terminate()
          return
        }
        alive = false
        try { ws.ping() } catch {}
      }, 15_000)

      ws.on('message', async (raw) => {
        let msg: WsRequest | WsResume
        try {
          msg = JSON.parse(raw.toString())
        } catch {
          return
        }

        if ((msg as WsResume).type === 'resume') {
          replayInProgress = true
          handleResume(server, ws, clientId, (msg as WsResume).lastSeqByTopic ?? {})
          replayInProgress = false
          flushLiveBuffer()
          send(ws, { type: 'event', topic: 'seq-watermark', seq: 0, payload: [server.getSeqWatermark()] })
          return
        }
        flushLiveBuffer()
        send(ws, { type: 'event', topic: 'seq-watermark', seq: 0, payload: [server.getSeqWatermark()] })

        const req = msg as WsRequest
        if (!req?.id || !req?.method) return
        const ctx = { clientId, deviceLabel, deviceId: deviceId ?? undefined }

        try {
          if (!server.hasHandler(req.method)) {
            send(ws, { id: req.id, error: { message: `Unknown method "${req.method}"` } })
            return
          }
          const result = await server.handle(req.method, req.args ?? [], ctx)
          send(ws, { id: req.id, result })
        } catch (err) {
          send(ws, { id: req.id, error: { message: err instanceof Error ? err.message : String(err) } })
        }
      })

      ws.on('close', () => {
        clearInterval(interval)
        clearTimeout(resumeTimer)
        for (const u of session.topicUnsubs) u()
        sessions.delete(id)
        server.broadcast('presence', { type: 'disconnect', id })
        log.info(`ws session ${id} closed`)
      })

      log.info(`ws session ${id} opened (device=${deviceLabel})`)
    })
  })

  return {
    close: () => {
      for (const session of sessions.values()) {
        try { session.socket.close(1001, 'going away') } catch {}
      }
      sessions.clear()
      wss.close()
    },
    sessions,
  }
}

function send(ws: WebSocket, payload: unknown): void {
  if (!canSend(ws)) return
  ws.send(JSON.stringify(payload))
}

function sendRaw(ws: WebSocket, frame: string): void {
  if (!canSend(ws)) return
  ws.send(frame)
}

function canSend(ws: WebSocket): boolean {
  if (ws.readyState !== WebSocket.OPEN) return false
  if (ws.bufferedAmount > WS_BUFFERED_AMOUNT_LIMIT) {
    log.warn(`ws bufferedAmount exceeded ${WS_BUFFERED_AMOUNT_LIMIT}; terminating session`)
    ws.terminate()
    return false
  }
  return true
}

// emit() hands the SAME payload array reference to every topic listener, so a
// WeakMap keyed on it dedupes the JSON.stringify across all connected sockets:
// one broadcast → one serialization, regardless of paired-device count.
const frameCache = new WeakMap<object, string>()
function eventFrame(topic: RpcTopic, seq: number, payload: unknown[]): string {
  const cached = frameCache.get(payload)
  if (cached !== undefined) return cached
  const frame = JSON.stringify({ type: 'event', topic, seq, payload })
  frameCache.set(payload, frame)
  return frame
}

function parseAuth(req: IncomingMessage): string | null {
  const header = req.headers['authorization']
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim()
  }
  if (req.url) {
    const url = new URL(req.url, 'http://localhost')
    const token = url.searchParams.get('token')
    if (token) return token
  }
  return null
}

function handleResume(
  server: SolusServer,
  ws: WebSocket,
  clientId: string,
  lastSeqByTopic: Partial<Record<RpcTopic, number>>,
): void {
  for (const [topic, lastSeq] of Object.entries(lastSeqByTopic)) {
    if (typeof lastSeq !== 'number') continue
    const events = server.replayFrom(topic as RpcTopic, lastSeq)
    if (events === null) {
      // Gap detected — signal client to re-bootstrap instead of sending a stale snapshot.
      server.sendTo(clientId, 'seq-reset', server.getSeqWatermark())
      return
    }
    for (const ev of events) {
      send(ws, { type: 'event', topic, seq: ev.seq, payload: ev.payload })
    }
  }
}

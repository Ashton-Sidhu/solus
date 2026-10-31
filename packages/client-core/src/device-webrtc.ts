// Adapted from T3 Code packages/client-runtime/src/device/stream.ts (MIT).
import { z } from 'zod'

const settingsSchema = z.object({
  transport: z.literal('webrtc'),
  iceServers: z.array(z.object({ urls: z.union([z.string(), z.array(z.string())]), username: z.string().optional(), credential: z.string().optional() })).optional(),
  iceTransportPolicy: z.enum(['all', 'relay']).optional(),
})

/** One visible cloud preview. Frames stop with the owning pane; ICE never trickles. */
export function cloudDeviceVideo(options: {
  openUrl: () => Promise<string>
  present: (video: HTMLVideoElement, width: number, height: number) => void
  status: (status: 'connecting' | 'streaming' | 'ended', detail?: string) => void
  /** EAS may also serve AVCC; return control to the normal decoder in that case. */
  fallback: () => void
}): () => void {
  let stopped = false
  let peer: RTCPeerConnection | null = null
  let video: HTMLVideoElement | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let frameCallback: number | undefined
  let sessionId: string | null = null
  let abort = new AbortController()
  let lastFrame = 0
  let watchdog: ReturnType<typeof setInterval> | undefined

  const retire = () => {
    abort.abort()
    if (video && frameCallback !== undefined) video.cancelVideoFrameCallback(frameCallback)
    peer?.close(); peer = null
    if (video) { video.srcObject = null; video.remove(); video = null }
    clearInterval(watchdog)
    if (sessionId) {
      const closing = sessionId
      sessionId = null
      void options.openUrl().then((url) => fetch(`${url}/close`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: closing }), keepalive: true })).catch(() => {})
    }
  }
  const retry = () => {
    retire()
    if (!stopped) { options.status('connecting'); timer = setTimeout(() => { void start() }, 1500) }
  }
  const start = async () => {
    if (stopped) return
    options.status('connecting')
    abort = new AbortController()
    const signal = abort.signal
    const isCurrent = () => !stopped && !signal.aborted
    try {
      const base = await options.openUrl()
      const config = await fetch(`${base}/config`, { signal })
      const api = z.object({ stream: settingsSchema.optional(), streamSettings: settingsSchema.optional() }).safeParse(await config.json())
      if (!isCurrent()) return
      const settings = api.success ? api.data.streamSettings ?? api.data.stream : null
      if (!settings) { options.fallback(); return }
      if (!('RTCPeerConnection' in globalThis)) { options.status('ended', 'This client cannot decode WebRTC video.'); return }
      const connection = new RTCPeerConnection({ iceServers: settings.iceServers, iceTransportPolicy: settings.iceTransportPolicy ?? 'all' })
      peer = connection
      sessionId = crypto.randomUUID()
      const element = document.createElement('video')
      video = element
      element.muted = true; element.playsInline = true
      element.setAttribute('aria-hidden', 'true')
      element.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:0;top:0'
      document.body.append(element)
      const paint = () => {
        if (!isCurrent()) return
        if (element.videoWidth && element.videoHeight) {
          lastFrame = Date.now()
          options.present(element, element.videoWidth, element.videoHeight)
          options.status('streaming')
        }
        frameCallback = element.requestVideoFrameCallback(paint)
      }
      connection.addTransceiver('video', { direction: 'recvonly' })
      connection.ontrack = (event) => {
        if (!isCurrent()) return
        element.srcObject = event.streams[0] ?? new MediaStream([event.track])
        void element.play().catch(() => {})
        frameCallback = element.requestVideoFrameCallback(paint)
      }
      connection.onconnectionstatechange = () => { if (isCurrent() && connection.connectionState === 'failed') retry() }
      await connection.setLocalDescription(await connection.createOffer())
      await new Promise<void>((resolve) => {
        if (connection.iceGatheringState === 'complete') return resolve()
        const done = () => { clearTimeout(deadline); connection.removeEventListener('icegatheringstatechange', changed); signal.removeEventListener('abort', done); resolve() }
        const changed = () => { if (connection.iceGatheringState === 'complete') done() }
        const deadline = setTimeout(done, 15_000)
        connection.addEventListener('icegatheringstatechange', changed)
        signal.addEventListener('abort', done, { once: true })
      })
      if (!isCurrent()) return
      const response = await fetch(`${base}/offer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'offer', sdp: connection.localDescription?.sdp, codec: 'h264', sessionId }), signal })
      if (!response.ok) throw new Error('The device refused the video connection.')
      const answer = z.object({ type: z.literal('answer'), sdp: z.string() }).parse(await response.json())
      if (!isCurrent()) return
      await connection.setRemoteDescription(answer)
      lastFrame = Date.now()
      watchdog = setInterval(() => { if (isCurrent() && Date.now() - lastFrame > 20_000) retry() }, 5000)
    } catch { if (isCurrent()) retry() }
  }
  void start()
  return () => { stopped = true; clearTimeout(timer); retire() }
}

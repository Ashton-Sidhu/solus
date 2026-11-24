import type { WebContents } from 'electron'
import { z } from 'zod'

const FRAME_LOOKUP_MS = 1_000
const MAX_FRAME_DEPTH = 8

const attachedSchema = z.object({
  sessionId: z.string(),
  targetInfo: z.object({ targetId: z.string(), type: z.literal('iframe') }),
})
const detachedSchema = z.object({ sessionId: z.string() })
const viewportSchema = z.object({ cssLayoutViewport: z.object({ pageX: z.number(), pageY: z.number() }) })
const hitSchema = z.object({ backendNodeId: z.number() })
const nodeSchema = z.object({ node: z.object({ frameId: z.string().optional() }) })
const boxSchema = z.object({ model: z.object({ content: z.array(z.number()).length(8) }) })

type TargetEventParams = z.input<typeof attachedSchema> | z.input<typeof detachedSchema>

type Point = { x: number; y: number }
type ClickPoint = Point & { frame?: FrameSession }
type FrameSession = { sessionId: string; parentSessionId?: string; detached: AbortController }

/** A parked webview has no compositor hit test for out-of-process frames.
 * Find the owning iframe in the page and send input to its own CDP session. */
export class GuestClick {
  private readonly frames = new Map<string, FrameSession>()

  constructor(private readonly contents: WebContents) {}

  async attachFrames(sessionId?: string): Promise<void> {
    await this.contents.debugger.sendCommand('Target.setAutoAttach', {
      autoAttach: true,
      flatten: true,
      waitForDebuggerOnStart: false,
      filter: [{ type: 'iframe' }, { exclude: true }],
    }, sessionId)
  }

  onTargetMessage = (_event: Electron.Event, method: string, params: TargetEventParams, parentSessionId?: string): void => {
    if (method === 'Target.attachedToTarget') {
      const attached = attachedSchema.safeParse(params)
      if (!attached.success) return
      const { sessionId, targetInfo } = attached.data
      if (parentSessionId && !this.frameForSession(parentSessionId)) return
      const previous = this.frames.get(targetInfo.targetId)
      if (previous?.sessionId === sessionId) return
      if (previous) this.forgetSession(previous.sessionId)
      this.frames.set(targetInfo.targetId, {
        sessionId,
        parentSessionId: parentSessionId || undefined,
        detached: new AbortController(),
      })
      void this.attachFrames(sessionId).catch(() => {})
    } else if (method === 'Target.detachedFromTarget') {
      const detached = detachedSchema.safeParse(params)
      if (detached.success) this.forgetSession(detached.data.sessionId)
    }
  }

  clear(): void {
    for (const frame of this.frames.values()) frame.detached.abort()
    this.frames.clear()
  }

  private frameForSession(sessionId: string): FrameSession | undefined {
    for (const frame of this.frames.values()) if (frame.sessionId === sessionId) return frame
  }

  private forgetSession(sessionId: string): void {
    for (const [frameId, frame] of this.frames) {
      if (frame.sessionId !== sessionId && frame.parentSessionId !== sessionId) continue
      this.frames.delete(frameId)
      frame.detached.abort()
      if (frame.sessionId !== sessionId) this.forgetSession(frame.sessionId)
    }
  }

  async locate(point: Point, isForeground: boolean): Promise<ClickPoint> {
    if (isForeground || this.frames.size === 0) return point
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.locateFrame(point, () => timer !== undefined).catch(() => point),
        new Promise<Point>((resolve) => { timer = setTimeout(() => resolve(point), FRAME_LOOKUP_MS) }),
      ])
    } finally {
      clearTimeout(timer)
      timer = undefined
    }
  }

  private async locateFrame(point: Point, stillWaiting: () => boolean): Promise<ClickPoint> {
    let { x, y } = point
    let sessionId: string | undefined
    const cdp = this.contents.debugger
    for (let depth = 0; depth < MAX_FRAME_DEPTH; depth++) {
      const viewport = viewportSchema.parse(await cdp.sendCommand('Page.getLayoutMetrics', {}, sessionId))
      if (!stillWaiting()) break
      const hit = hitSchema.parse(await cdp.sendCommand('DOM.getNodeForLocation', {
        x: Math.round(x + viewport.cssLayoutViewport.pageX),
        y: Math.round(y + viewport.cssLayoutViewport.pageY),
        includeUserAgentShadowDOM: true,
      }, sessionId))
      if (!stillWaiting()) break
      const { node } = nodeSchema.parse(await cdp.sendCommand('DOM.describeNode', hit, sessionId))
      const child = node.frameId ? this.frames.get(node.frameId) : undefined
      if (!stillWaiting() || !child || child.parentSessionId !== sessionId) break
      const { model } = boxSchema.parse(await cdp.sendCommand('DOM.getBoxModel', hit, sessionId))
      if (!stillWaiting() || child.detached.signal.aborted) break
      const xs = model.content.filter((_, index) => index % 2 === 0)
      const ys = model.content.filter((_, index) => index % 2 !== 0)
      const left = Math.min(...xs)
      const top = Math.min(...ys)
      // The border and padding belong to the parent document.
      if (x < left || x >= Math.max(...xs) || y < top || y >= Math.max(...ys)) break
      x -= left
      y -= top
      sessionId = child.sessionId
    }
    const frame = sessionId ? this.frameForSession(sessionId) : undefined
    return frame ? { x, y, frame } : point
  }
}

/** Save the workspace focus before Chromium's native press can move it.
 * Both scripts run in the embedder. Guest scripts cannot read that state. */
export function beforeGuestClick(host: WebContents, guestId: number): Promise<boolean> {
  return host.executeJavaScript(`(() => {
    const guest = [...document.querySelectorAll('webview')].find(view => {
      try { return view.getWebContentsId() === ${guestId}; } catch { return false; }
    });
    if (!guest) return false;
    const active = document.activeElement;
    globalThis.__solusGuestClickFocus?.delete(guest);
    if (active instanceof HTMLElement && active !== guest && active !== document.body) {
      (globalThis.__solusGuestClickFocus ??= new WeakMap()).set(guest, active);
    }
    const rect = guest.getBoundingClientRect();
    return document.visibilityState === 'visible' && document.hasFocus()
      && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight;
  })()`).then((result) => result === true)
}

export async function restoreGuestClickFocus(host: WebContents, guestId: number): Promise<void> {
  await host.executeJavaScript(`(() => {
    const guest = [...document.querySelectorAll('webview')].find(view => {
      try { return view.getWebContentsId() === ${guestId}; } catch { return false; }
    });
    if (!guest) return;
    const saved = globalThis.__solusGuestClickFocus?.get(guest);
    globalThis.__solusGuestClickFocus?.delete(guest);
    if (saved?.isConnected && document.activeElement === guest) saved.focus({ preventScroll: true });
  })()`)
}

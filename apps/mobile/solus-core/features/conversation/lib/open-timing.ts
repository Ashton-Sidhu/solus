/**
 * One log line for each session open: the time from the press on its row to
 * the first rows on screen, in parts. A build made with
 * `EXPO_PUBLIC_SOLUS_OPEN_TRACE=1` writes it to the console. It names no
 * content of the session.
 *
 * `[session-open] {"event":"session_open_painted","source":"saved",...}`
 *
 * - `pressToOpenMs`: the press on the row to the start of the open (navigation).
 * - `diskMs`: the start of the open to the saved page read from the device.
 * - `prefetchWaitMs`: the start of the open to the page that a prefetch read.
 * - `networkMs`: the open's own history request to its answer.
 * - `buildMs`: the conversion of the page into the transcript model.
 * - `renderMs`: the model given to the screen to two frames later.
 * - `totalMs`: the press (else the start of the open) to the painted rows.
 */

export type OpenPaintSource = 'saved' | 'prefetch' | 'host'

export interface SessionOpenTimingLine {
  event: 'session_open_painted'
  sessionId: string
  source: OpenPaintSource
  pressToOpenMs?: number
  diskMs?: number
  prefetchWaitMs?: number
  networkMs?: number
  buildMs?: number
  renderMs: number
  totalMs: number
}

type Sink = (line: SessionOpenTimingLine) => void

const defaultSink: Sink = (line) => console.info('[session-open] ' + JSON.stringify(line))
let sink: Sink | null = process.env.EXPO_PUBLIC_SOLUS_OPEN_TRACE === '1' ? defaultSink : null

/** Replaces where the lines go; null turns them off. For tests and tools. */
export function setOpenTimingSink(next: Sink | null): void {
  sink = next
}

const now = () => performance.now()
const presses = new Map<string, number>()
const MAX_PRESSES = 16

/** A press on the row of a session: its open measures from here. */
export function noteSessionPress(hostId: string, sessionId: string): void {
  if (!sink) return
  const key = JSON.stringify([hostId, sessionId])
  presses.delete(key)
  if (presses.size >= MAX_PRESSES) presses.delete(presses.keys().next().value!)
  presses.set(key, now())
}

const afterTwoFrames = (done: () => void) => {
  if (!('requestAnimationFrame' in globalThis)) {
    setTimeout(done, 0)
    return
  }
  requestAnimationFrame(() => requestAnimationFrame(done))
}

export class OpenTiming {
  private readonly startedAt = now()
  private readonly pressedAt: number | undefined
  private diskMs?: number
  private prefetchWaitMs?: number
  private requestAt?: number
  private networkMs?: number
  private buildMs?: number
  private painted = false

  private constructor(private readonly sink: Sink, hostId: string, private readonly sessionId: string) {
    const key = JSON.stringify([hostId, sessionId])
    this.pressedAt = presses.get(key)
    presses.delete(key)
  }

  /** Null when no sink takes the lines: an open then measures nothing. */
  static start(hostId: string, sessionId: string): OpenTiming | null {
    return sink ? new OpenTiming(sink, hostId, sessionId) : null
  }

  savedPageRead(fromPrefetch: boolean): void {
    if (fromPrefetch) this.prefetchWaitMs ??= now() - this.startedAt
    else this.diskMs ??= now() - this.startedAt
  }

  requestSent(): void {
    this.requestAt ??= now()
  }

  answered(): void {
    if (this.requestAt !== undefined) this.networkMs ??= now() - this.requestAt
  }

  /** Converts a page into a model; the last conversion before the paint is the one measured. */
  build<T>(convert: () => T): T {
    const startedAt = now()
    const built = convert()
    if (!this.painted) this.buildMs = now() - startedAt
    return built
  }

  /** The model is given to the screen. The first one ends the measure. */
  shown(source: OpenPaintSource): void {
    if (this.painted) return
    this.painted = true
    const renderAt = now()
    afterTwoFrames(() => {
      const end = now()
      const round = (ms: number | undefined) => ms === undefined ? undefined : Math.round(ms)
      this.sink({
        event: 'session_open_painted', sessionId: this.sessionId, source,
        pressToOpenMs: round(this.pressedAt === undefined ? undefined : this.startedAt - this.pressedAt),
        diskMs: round(this.diskMs), prefetchWaitMs: round(this.prefetchWaitMs), networkMs: round(this.networkMs),
        buildMs: round(this.buildMs), renderMs: Math.round(end - renderAt),
        totalMs: Math.round(end - (this.pressedAt ?? this.startedAt)),
      })
    })
  }
}

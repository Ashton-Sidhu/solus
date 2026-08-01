import { appendFile, appendFileSync, mkdirSync, writeFileSync } from 'fs'
import { inspect } from 'util'
import { join } from 'path'
import { isPackagedRuntime, logsDir } from './platform/paths'
import { installBrokenPipeGuard } from './broken-pipe'

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void
  info(msg: string, data?: Record<string, unknown>): void
  warn(msg: string, data?: Record<string, unknown>): void
  error(msg: string, data?: Record<string, unknown>): void
  metric(label: string, durationMs: number, data?: Record<string, unknown>): void
  /** Returns a logger that stamps `bound` fields (e.g. `{ sessionId }`) onto every entry. */
  child(bound: Record<string, unknown>): Logger
}

const isDevRuntime = !isPackagedRuntime()
const activeLogLevel: LogLevel = isDevRuntime ? 'debug' : 'info'
const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
}
const METRIC_COLOR = '\x1b[35m'
const RESET = '\x1b[0m'
const DIM = '\x1b[2m'

const CONSOLE_FN: Record<LogLevel, (...args: unknown[]) => void> = {
  debug: console.debug,
  info: console.log,
  warn: console.warn,
  error: console.error,
}
const stdoutGuard = isDevRuntime ? installBrokenPipeGuard(process.stdout) : null
const stderrGuard = isDevRuntime ? installBrokenPipeGuard(process.stderr) : null

function writeToConsole(level: LogLevel, message: string): void {
  const guard = level === 'debug' || level === 'info' ? stdoutGuard : stderrGuard
  guard?.write(() => CONSOLE_FN[level](message))
}

function formatDevData(data: Record<string, unknown>): string {
  return inspect(data, {
    colors: true,
    compact: false,
    depth: null,
    maxArrayLength: null,
    maxStringLength: null,
    breakLength: 120,
  })
}

// ─── Buffered NDJSON file writer ───
// Dev: <repo root>/dev.log, truncated on boot — pure NDJSON so agents can query it
// with grep/jq (one entry per line, sessionId top-level). Prod: <logsDir>/solus.log.

const FLUSH_INTERVAL_MS = 500
const MAX_BUFFER_SIZE = 64
// Cap string values in file entries — a dumped stream buffer must not produce a megabyte line.
const MAX_STRING_LENGTH = 2000

let logPath: string | null = null
let buffer: string[] = []
let timer: ReturnType<typeof setInterval> | null = null
const inFlight = new Map<number, string>()
let nextChunkId = 1
let logEventSink: ((msg: string) => void) | null = null

/** Registers the optional analytics bridge for info-level log event names. */
export function setLogEventSink(sink: ((msg: string) => void) | null): void {
  logEventSink = sink
}

function getLogPath(): string {
  if (!logPath) {
    if (isDevRuntime) {
      logPath = join(process.cwd(), 'dev.log')
      try { writeFileSync(logPath, '') } catch {}
    } else {
      const dir = logsDir()
      mkdirSync(dir, { recursive: true })
      logPath = join(dir, 'solus.log')
    }
  }
  return logPath
}

function truncateStrings(_key: string, value: unknown): unknown {
  if (typeof value === 'string' && value.length > MAX_STRING_LENGTH) {
    return `${value.slice(0, MAX_STRING_LENGTH)}…[+${value.length - MAX_STRING_LENGTH} chars]`
  }
  return value
}

function pushEntry(entry: Record<string, unknown>): void {
  let line: string
  try {
    line = JSON.stringify(entry, truncateStrings)
  } catch {
    line = JSON.stringify({ ts: entry.ts, level: entry.level, tag: entry.tag, file: entry.file, msg: entry.msg, logError: 'unserializable data' })
  }
  buffer.push(line + '\n')
  if (buffer.length >= MAX_BUFFER_SIZE) flush()
  ensureTimer()
}

function flush(): void {
  if (buffer.length === 0) return
  const chunk = buffer.join('')
  buffer = []
  const chunkId = nextChunkId++
  inFlight.set(chunkId, chunk)
  appendFile(getLogPath(), chunk, () => { inFlight.delete(chunkId) })
}

function ensureTimer(): void {
  if (timer) return
  timer = setInterval(flush, FLUSH_INTERVAL_MS)
  if (timer && typeof timer === 'object' && 'unref' in timer) {
    timer.unref()
  }
}

// ─── Core emit ───

function emit(level: LogLevel, tag: string, file: string, bound: Record<string, unknown> | undefined, msg: string, data?: Record<string, unknown>): void {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[activeLogLevel]) return

  const merged = bound ? { ...bound, ...data } : data

  if (isDevRuntime) {
    const t = new Date().toISOString().slice(11, 23)
    const color = LEVEL_COLORS[level]
    const lvl = level.toUpperCase().padEnd(5)
    const prefix = `${DIM}${t}${RESET} ${color}${lvl}${RESET} ${DIM}[${tag}]${RESET} ${DIM}(${file})${RESET}`
    if (merged && Object.keys(merged).length > 0) {
      writeToConsole(level, `${prefix} ${msg}\n${formatDevData(merged)}`)
    } else {
      writeToConsole(level, `${prefix} ${msg}`)
    }
  }

  const entry: Record<string, unknown> = { ts: new Date().toISOString(), level, tag, file, msg }
  if (merged) Object.assign(entry, merged)
  pushEntry(entry)
  if (level === 'info' && logEventSink) {
    try {
      logEventSink(msg)
    } catch {}
  }
}

// ─── Public API ───

/**
 * Whether `debug` output would actually be emitted. Lets hot paths skip building
 * expensive log payloads (JSON.stringify of large stream buffers) when debug is
 * gated out — in production `activeLogLevel` is `info`, so the work is wasted.
 */
export const isDebugEnabled = LEVEL_PRIORITY.debug >= LEVEL_PRIORITY[activeLogLevel]

function makeLogger(tag: string, file: string, bound?: Record<string, unknown>): Logger {
  return {
    debug: (msg, data?) => emit('debug', tag, file, bound, msg, data),
    info: (msg, data?) => emit('info', tag, file, bound, msg, data),
    warn: (msg, data?) => emit('warn', tag, file, bound, msg, data),
    error: (msg, data?) => emit('error', tag, file, bound, msg, data),
    metric(label: string, durationMs: number, data?: Record<string, unknown>) {
      const payload = bound ? { durationMs, ...bound, ...data } : { durationMs, ...data }
      if (isDevRuntime) {
        const t = new Date().toISOString().slice(11, 23)
        const prefix = `${DIM}${t}${RESET} ${METRIC_COLOR}METRIC${RESET} ${DIM}[${tag}]${RESET} ${DIM}(${file})${RESET}`
        stdoutGuard?.write(() => console.log(`${prefix} ${label}\n${formatDevData(payload)}`))
      }
      pushEntry({ ts: new Date().toISOString(), level: 'metric', tag, file, label, ...payload })
    },
    child: (extra) => makeLogger(tag, file, { ...bound, ...extra }),
  }
}

export function createLogger(tag: string, file: string): Logger {
  return makeLogger(tag, file)
}

export function flushLogs(): void {
  if (timer) { clearInterval(timer); timer = null }
  const pendingInflight = Array.from(inFlight.values()).join('')
  const pending = pendingInflight + buffer.join('')
  inFlight.clear()
  buffer = []
  if (pending) {
    try { appendFileSync(getLogPath(), pending) } catch {}
  }
}

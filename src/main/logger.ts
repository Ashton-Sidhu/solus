import { appendFile, appendFileSync, mkdirSync, writeFileSync } from 'fs'
import { inspect } from 'util'
import { join } from 'path'
import { isPackagedRuntime, logsDir } from './platform/paths'
import { installBrokenPipeGuard } from './broken-pipe'
import { emitOtelLog, recordOtelDuration } from './otel'

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
const MAX_BUFFER_BYTES = 1024 * 1024
const MAX_ENTRY_BYTES = 64 * 1024
const MAX_LOG_DEPTH = 8
const MAX_LOG_ARRAY_ITEMS = 20
const MAX_LOG_OBJECT_KEYS = 100
const MAX_LOG_NODES = 2_000
// Cap string values in file entries — a dumped stream buffer must not produce a megabyte line.
const MAX_STRING_LENGTH = 2000

let logPath: string | null = null
let buffer: string[] = []
let bufferedBytes = 0
let timer: ReturnType<typeof setInterval> | null = null
let activeWrite: string | null = null
let droppedEntries = 0
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

function boundedLogValue(
  value: unknown,
  depth: number,
  state: { nodes: number; seen: WeakSet<object> },
): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}…[+${value.length - MAX_STRING_LENGTH} chars]`
      : value
  }
  if (value == null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return typeof value === 'bigint' ? String(value) : value
  }
  if (typeof value !== 'object') return String(value)
  if (state.seen.has(value)) return '[Circular]'
  if (depth >= MAX_LOG_DEPTH || state.nodes++ >= MAX_LOG_NODES) return '[Truncated]'
  state.seen.add(value)

  if (ArrayBuffer.isView(value)) return `[${value.constructor.name} ${value.byteLength} bytes]`
  if (value instanceof ArrayBuffer) return `[ArrayBuffer ${value.byteLength} bytes]`
  if (value instanceof Error) {
    return boundedLogValue({ name: value.name, message: value.message, stack: value.stack }, depth + 1, state)
  }
  if (Array.isArray(value)) {
    const result = value.slice(0, MAX_LOG_ARRAY_ITEMS)
      .map((item) => boundedLogValue(item, depth + 1, state))
    if (value.length > MAX_LOG_ARRAY_ITEMS) result.push(`…[+${value.length - MAX_LOG_ARRAY_ITEMS} items]`)
    return result
  }

  const result: Record<string, unknown> = {}
  let keys = 0
  for (const key in value as Record<string, unknown>) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue
    if (keys++ >= MAX_LOG_OBJECT_KEYS) {
      result.logTruncated = 'additional object keys omitted'
      break
    }
    try {
      result[key] = boundedLogValue((value as Record<string, unknown>)[key], depth + 1, state)
    } catch {
      result[key] = '[Unreadable]'
    }
  }
  return result
}

export function serializeLogEntry(entry: Record<string, unknown>): string {
  let line: string
  try {
    line = JSON.stringify(boundedLogValue(entry, 0, { nodes: 0, seen: new WeakSet() }))
  } catch {
    line = JSON.stringify({ ts: entry.ts, level: entry.level, tag: entry.tag, file: entry.file, msg: entry.msg, logError: 'unserializable data' })
  }
  if (Buffer.byteLength(line) > MAX_ENTRY_BYTES) {
    line = JSON.stringify({
      ts: entry.ts,
      level: entry.level,
      tag: entry.tag,
      file: entry.file,
      msg: entry.msg,
      logError: 'entry exceeded byte limit',
    })
  }
  return line + '\n'
}

function pushEntry(entry: Record<string, unknown>): void {
  const line = serializeLogEntry(entry)
  const lineBytes = Buffer.byteLength(line)
  if (bufferedBytes + lineBytes > MAX_BUFFER_BYTES) {
    droppedEntries++
    return
  }
  buffer.push(line)
  bufferedBytes += lineBytes
  if (buffer.length >= MAX_BUFFER_SIZE || bufferedBytes >= MAX_BUFFER_BYTES / 2) flush()
  ensureTimer()
}

function flush(): void {
  if (activeWrite || buffer.length === 0) return
  const chunk = buffer.join('')
  buffer = []
  bufferedBytes = 0
  activeWrite = chunk
  let path: string
  try {
    path = getLogPath()
  } catch (error) {
    activeWrite = null
    console.error('[solus:logger] log path unavailable', error)
    return
  }
  appendFile(path, chunk, (error) => {
    activeWrite = null
    if (error) {
      console.error('[solus:logger] log write failed', error)
      return
    }
    if (droppedEntries > 0) {
      const dropped = droppedEntries
      droppedEntries = 0
      pushEntry({
        ts: new Date().toISOString(),
        level: 'warn',
        tag: 'main',
        file: 'logger.ts',
        msg: 'log_entries_dropped',
        count: dropped,
      })
    }
    flush()
  })
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
  emitOtelLog(level, msg, { tag, file, ...merged })
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
      recordOtelDuration(label, durationMs, { tag, ...bound, ...data })
    },
    child: (extra) => makeLogger(tag, file, { ...bound, ...extra }),
  }
}

export function createLogger(tag: string, file: string): Logger {
  return makeLogger(tag, file)
}

export function flushLogs(): void {
  if (timer) { clearInterval(timer); timer = null }
  // `activeWrite` was already submitted to appendFile; appending it again here
  // races the callback and duplicates records. Only synchronously drain bytes
  // that have not yet been handed to the filesystem.
  const pending = buffer.join('')
  buffer = []
  bufferedBytes = 0
  if (pending) {
    try { appendFileSync(getLogPath(), pending) } catch (error) {
      console.error('[solus:logger] final log write failed', error)
    }
  }
}

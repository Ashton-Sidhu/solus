import { appendFile, appendFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { inspect } from 'util'
import { join } from 'path'
import { trace, type AttributeValue, type Attributes } from '@opentelemetry/api'
import { isPackagedRuntime, logsDir } from './platform/paths'
import { platformServices } from './platform/services'
import { installBrokenPipeGuard } from './broken-pipe'
import { LOG_EVENT_ATTRS } from './observability/registries'

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
  debug<Data extends object>(msg: string, data?: Data): void
  info<Data extends object>(msg: string, data?: Data): void
  warn<Data extends object>(msg: string, data?: Data): void
  error<Data extends object>(msg: string, data?: Data): void
  /** Returns a logger that stamps `bound` fields (e.g. `{ sessionId }`) onto every entry. */
  child<Bound extends object>(bound: Bound): Logger
}

interface LogEntry {
  ts: string
  level: string
  tag: string
  file: string
  msg?: string
  count?: number
  traceId?: string
  spanId?: string
}

// Resolved lazily, never at module load. `isPackagedRuntime()` reads the
// `appInfo` that the desktop main registers via `configurePlatformServices`,
// but ES module evaluation runs this file's body before any statement in
// `apps/desktop/src/main/index.ts`. A module-load constant therefore always
// read an unconfigured (development-looking) runtime and sent the packaged
// app's logs to `<cwd>/dev.log` — `/dev.log` for a Finder launch, where the
// write fails and is swallowed. Cache only once the runtime is knowable, so a
// log emitted before configuration cannot poison the answer for the process.
let devRuntimeCache: boolean | null = null

function isDevRuntime(): boolean {
  if (devRuntimeCache !== null) return devRuntimeCache
  const packaged = isPackagedRuntime()
  if (!packaged && !platformServices().appInfo) return true
  devRuntimeCache = !packaged
  return devRuntimeCache
}

function activeLogLevel(): LogLevel {
  return isDevRuntime() ? 'debug' : 'info'
}

const LEVEL_PRIORITY = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
} as const satisfies Record<LogLevel, number>

const LEVEL_COLORS = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
} as const satisfies Record<LogLevel, string>
const RESET = '\x1b[0m'
const DIM = '\x1b[2m'

const CONSOLE_FN = {
  debug: console.debug,
  info: console.log,
  warn: console.warn,
  error: console.error,
} as const satisfies Record<LogLevel, (...args: unknown[]) => void>
// Installed on first console write rather than at module load, for the same
// reason the runtime flag is resolved lazily: only a development runtime writes
// to the console at all, and that is not known yet when this module evaluates.
let stdoutGuard: ReturnType<typeof installBrokenPipeGuard> | null = null
let stderrGuard: ReturnType<typeof installBrokenPipeGuard> | null = null

function consoleGuard(level: LogLevel): ReturnType<typeof installBrokenPipeGuard> {
  if (level === 'debug' || level === 'info') {
    return (stdoutGuard ??= installBrokenPipeGuard(process.stdout))
  }
  return (stderrGuard ??= installBrokenPipeGuard(process.stderr))
}

function writeToConsole(level: LogLevel, message: string): void {
  consoleGuard(level).write(() => CONSOLE_FN[level](message))
}

function formatDevData<Data extends object>(data: Data): string {
  // Bounded like the NDJSON file writer below: an uncapped inspect renders a
  // whole tool payload to stdout synchronously on every log call in dev.
  return inspect(data, {
    colors: true,
    compact: false,
    depth: 8,
    maxArrayLength: 100,
    maxStringLength: 2000,
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
/**
 * The durable log the installed app keeps: always `<logsDir>/solus.log`, on
 * every runtime. Unlike `logFilePath()` this never answers `dev.log`, because
 * "Open Solus logs" is a production diagnostic — a developer running from the
 * repo wants the packaged app's history, and reads `dev.log` from the repo root
 * directly. On a development host this file is therefore not the one the
 * running process appends to; it holds the last packaged run.
 *
 * Creates the directory and the file so the command always opens something
 * rather than handing the editor a path that does not exist.
 */
export function productionLogFilePath(): string {
  const dir = logsDir()
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'solus.log')
  if (!existsSync(path)) {
    try { writeFileSync(path, '') } catch {}
  }
  return path
}

/**
 * The file this host writes its log to: `<repo root>/dev.log` in development,
 * `<logsDir>/solus.log` when packaged. Resolving it also creates (and, in
 * development, truncates) the file, exactly as the first log write would.
 */
export function logFilePath(): string {
  if (!logPath) {
    if (isDevRuntime()) {
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

function boundedLogJson<Entry extends LogEntry>(entry: Entry): string {
  const seen = new WeakSet<object>()
  const depths = new WeakMap<object, number>()
  let nodes = 0

  const line = JSON.stringify(entry, function (_key, value) {
    const tag = Object.prototype.toString.call(value)
    if (tag === '[object String]') {
      return value.length > MAX_STRING_LENGTH
        ? `${value.slice(0, MAX_STRING_LENGTH)}…[+${value.length - MAX_STRING_LENGTH} chars]`
        : value
    }
    if (tag === '[object BigInt]') return String(value)
    if (value == null || tag === '[object Number]' || tag === '[object Boolean]') return value
    if (ArrayBuffer.isView(value)) return `[${value.constructor.name} ${value.byteLength} bytes]`
    if (value instanceof ArrayBuffer) return `[ArrayBuffer ${value.byteLength} bytes]`
    if (seen.has(value)) return '[Circular]'

    const depth = (depths.get(this) ?? -1) + 1
    if (depth >= MAX_LOG_DEPTH || nodes++ >= MAX_LOG_NODES) return '[Truncated]'
    seen.add(value)

    if (value instanceof Error) {
      const errorValue = { name: value.name, message: value.message, stack: value.stack }
      depths.set(errorValue, depth)
      return errorValue
    }
    if (tag !== '[object Object]' && tag !== '[object Array]') return String(value)
    if (Array.isArray(value)) {
      const arrayValue = value.slice(0, MAX_LOG_ARRAY_ITEMS)
      if (value.length > MAX_LOG_ARRAY_ITEMS) {
        arrayValue.push(`…[+${value.length - MAX_LOG_ARRAY_ITEMS} items]`)
      }
      depths.set(arrayValue, depth)
      return arrayValue
    }

    const entries = Object.entries(value).slice(0, MAX_LOG_OBJECT_KEYS)
    if (Object.keys(value).length > MAX_LOG_OBJECT_KEYS) {
      entries.push(['logTruncated', 'additional object keys omitted'])
    }
    const objectValue = Object.fromEntries(entries)
    depths.set(objectValue, depth)
    return objectValue
  })

  return line ?? JSON.stringify({
    ts: entry.ts,
    level: entry.level,
    tag: entry.tag,
    file: entry.file,
    msg: entry.msg,
    logError: 'unserializable data',
  })
}

function spanEventAttributes<Data extends object>(data: Data | undefined): Attributes {
  const attributes: Attributes = {}
  if (!data) return attributes
  for (const [key, value] of Object.entries(data)) {
    const valueTag = Object.prototype.toString.call(value)
    let normalized: AttributeValue | undefined
    if (valueTag === '[object String]') normalized = String(value).slice(0, MAX_STRING_LENGTH)
    else if (valueTag === '[object Number]') {
      const numberValue = Number(value)
      normalized = Number.isFinite(numberValue) ? numberValue : String(value)
    } else if (valueTag === '[object Boolean]') normalized = Boolean(value)
    else if (valueTag === '[object BigInt]') normalized = String(value)
    else if (value != null) {
      try {
        const encoded = boundedLogJson({
          ts: '', level: 'info', tag: 'logger', file: 'logger.ts', value,
        })
        const valueStart = encoded.indexOf('"value":')
        const text = valueStart >= 0
          ? encoded.slice(valueStart + '"value":'.length, -1)
          : String(value)
        normalized = text.length > MAX_STRING_LENGTH ? `${text.slice(0, MAX_STRING_LENGTH)}…` : text
      } catch {
        normalized = String(value).slice(0, MAX_STRING_LENGTH)
      }
    }
    if (normalized !== undefined) attributes[key] = normalized
  }
  return attributes
}

export function serializeLogEntry(entry: LogEntry): string {
  let line: string
  try {
    line = boundedLogJson(entry)
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

function pushEntry(entry: LogEntry): void {
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
    path = logFilePath()
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
  if (timer instanceof Object && 'unref' in timer) {
    timer.unref()
  }
}

// ─── Core emit ───

function emit<Bound extends object, Data extends object>(
  level: LogLevel,
  tag: string,
  file: string,
  bound: Bound | undefined,
  msg: string,
  data?: Data,
): void {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[activeLogLevel()]) return

  const merged = bound ? { ...bound, ...data } : data

  if (isDevRuntime()) {
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

  const now = new Date()
  const activeSpan = trace.getActiveSpan()
  const spanContext = activeSpan?.spanContext()
  const entry: LogEntry = { ts: now.toISOString(), level, tag, file, msg }
  if (spanContext) {
    entry.traceId = spanContext.traceId
    entry.spanId = spanContext.spanId
  }
  if (merged) Object.assign(entry, merged)
  activeSpan?.addEvent(msg, {
    ...spanEventAttributes(merged),
    [LOG_EVENT_ATTRS.marker]: true,
    [LOG_EVENT_ATTRS.level]: level,
    [LOG_EVENT_ATTRS.tag]: tag,
    [LOG_EVENT_ATTRS.file]: file,
  }, now)
  pushEntry(entry)
}

// ─── Public API ───

/**
 * Whether `debug` output would actually be emitted. Lets hot paths skip building
 * expensive log payloads (JSON.stringify of large stream buffers) when debug is
 * gated out — in production `activeLogLevel` is `info`, so the work is wasted.
 */
export function isDebugEnabled(): boolean {
  return LEVEL_PRIORITY.debug >= LEVEL_PRIORITY[activeLogLevel()]
}

function makeLogger<Bound extends object = never>(tag: string, file: string, bound?: Bound): Logger {
  return {
    debug: (msg, data?) => emit('debug', tag, file, bound, msg, data),
    info: (msg, data?) => emit('info', tag, file, bound, msg, data),
    warn: (msg, data?) => emit('warn', tag, file, bound, msg, data),
    error: (msg, data?) => emit('error', tag, file, bound, msg, data),
    child: (extra) => makeLogger(tag, file, { ...bound, ...extra }),
  }
}

export function createLogger(tag: string, file: string): Logger {
  return makeLogger(tag, file, undefined)
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
    try { appendFileSync(logFilePath(), pending) } catch (error) {
      console.error('[solus:logger] final log write failed', error)
    }
  }
}

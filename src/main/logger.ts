import { appendFile, appendFileSync, mkdirSync } from 'fs'
import { inspect } from 'util'
import { join } from 'path'
import { isPackagedRuntime, logsDir } from './platform/paths'

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void
  info(msg: string, data?: Record<string, unknown>): void
  warn(msg: string, data?: Record<string, unknown>): void
  error(msg: string, data?: Record<string, unknown>): void
  metric(label: string, durationMs: number, data?: Record<string, unknown>): void
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

// ─── Buffered file writer (prod only) ───

const FLUSH_INTERVAL_MS = 500
const MAX_BUFFER_SIZE = 64

let logPath: string | null = null
let buffer: string[] = []
let timer: ReturnType<typeof setInterval> | null = null
const inFlight = new Map<number, string>()
let nextChunkId = 1

function getLogPath(): string {
  if (!logPath) {
    const dir = logsDir()
    mkdirSync(dir, { recursive: true })
    logPath = join(dir, 'solus.log')
  }
  return logPath
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

function emit(level: LogLevel, tag: string, file: string, msg: string, data?: Record<string, unknown>): void {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[activeLogLevel]) return

  if (isDevRuntime) {
    const t = new Date().toISOString().slice(11, 23)
    const color = LEVEL_COLORS[level]
    const lvl = level.toUpperCase().padEnd(5)
    const prefix = `${DIM}${t}${RESET} ${color}${lvl}${RESET} ${DIM}[${tag}]${RESET} ${DIM}(${file})${RESET}`
    if (data && Object.keys(data).length > 0) {
      CONSOLE_FN[level](`${prefix} ${msg}\n${formatDevData(data)}`)
    } else {
      CONSOLE_FN[level](`${prefix} ${msg}`)
    }
    return
  }

  const entry: Record<string, unknown> = { ts: new Date().toISOString(), level, tag, file, msg }
  if (data) Object.assign(entry, data)
  buffer.push(JSON.stringify(entry) + '\n')
  if (buffer.length >= MAX_BUFFER_SIZE) flush()
  ensureTimer()
}

// ─── Public API ───

/**
 * Whether `debug` output would actually be emitted. Lets hot paths skip building
 * expensive log payloads (JSON.stringify of large stream buffers) when debug is
 * gated out — in production `activeLogLevel` is `info`, so the work is wasted.
 */
export const isDebugEnabled = LEVEL_PRIORITY.debug >= LEVEL_PRIORITY[activeLogLevel]

export function createLogger(tag: string, file: string): Logger {
  return {
    debug: (msg, data?) => emit('debug', tag, file, msg, data),
    info: (msg, data?) => emit('info', tag, file, msg, data),
    warn: (msg, data?) => emit('warn', tag, file, msg, data),
    error: (msg, data?) => emit('error', tag, file, msg, data),
    metric(label: string, durationMs: number, data?: Record<string, unknown>) {
      const payload = { durationMs, ...data }
      if (isDevRuntime) {
        const t = new Date().toISOString().slice(11, 23)
        const prefix = `${DIM}${t}${RESET} ${METRIC_COLOR}METRIC${RESET} ${DIM}[${tag}]${RESET} ${DIM}(${file})${RESET}`
        console.log(`${prefix} ${label}\n${formatDevData(payload)}`)
        return
      }
      const entry: Record<string, unknown> = { ts: new Date().toISOString(), level: 'metric', tag, file, label, ...payload }
      buffer.push(JSON.stringify(entry) + '\n')
      if (buffer.length >= MAX_BUFFER_SIZE) flush()
      ensureTimer()
    },
  }
}

export function flushLogs(): void {
  if (isDevRuntime) return
  if (timer) { clearInterval(timer); timer = null }
  const pendingInflight = Array.from(inFlight.values()).join('')
  const pending = pendingInflight + buffer.join('')
  inFlight.clear()
  buffer = []
  if (pending) {
    try { appendFileSync(getLogPath(), pending) } catch {}
  }
}

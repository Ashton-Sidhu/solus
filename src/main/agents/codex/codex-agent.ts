import { EventEmitter } from 'events'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { join } from 'node:path'
import { getCliEnv } from '../../cli-env'
import { SOLUS_PLUGINS_DIR } from '../plugins'
import { createLogger } from '../../logger'
import type {
  CodexResponseFor,
  CodexClientParams,
  CodexTypedMethod,
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcResponse,
} from './codex-protocol'

const log = createLogger('CodexAppServerClient', 'codex-agent.ts')
const REQUEST_TIMEOUT_MS = 120_000

interface PendingRequest {
  resolve: (value: any) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type JsonRpcResult = JsonRpcResponse['result']
type JsonRpcErrorData = NonNullable<JsonRpcResponse['error']>['data']

export class CodexRpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: JsonRpcErrorData,
  ) {
    super(message)
    this.name = 'CodexRpcError'
  }
}

export class CodexAppServerClient extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null
  private buffer = ''
  private nextId = 1
  private pending = new Map<JsonRpcId, PendingRequest>()
  private startPromise: Promise<void> | null = null
  private didRestart = false
  private stopped = false

  /** True only after an explicit Codex operation has started the runtime. */
  get hasStarted(): boolean {
    return !!this.proc || !!this.startPromise
  }

  async request<M extends CodexTypedMethod>(method: M, params?: CodexClientParams<M>, timeoutMs?: number): Promise<CodexResponseFor<M>>
  async request<T = any, Params = never>(method: string, params?: Params, timeoutMs?: number): Promise<T>
  async request<T = any, Params = never>(method: string, params?: Params, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    await this.ensureStarted()
    const proc = this.proc
    if (!proc || proc.killed || !proc.stdin.writable) throw new Error('Codex app-server is not running')

    const id = this.nextId++
    const payload = { jsonrpc: '2.0', id, method }
    if (params !== undefined) Object.assign(payload, { params })

    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex app-server request timed out: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
    })

    proc.stdin.write(`${JSON.stringify(payload)}\n`)
    return promise
  }

  respond(id: JsonRpcId, result: JsonRpcResult): void {
    const proc = this.proc
    if (!proc || proc.killed || !proc.stdin.writable) return
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
  }

  async ensureStarted(): Promise<void> {
    if (this.proc && !this.proc.killed) return
    if (this.startPromise) return this.startPromise

    this.startPromise = this.start()
      .finally(() => { this.startPromise = null })
    return this.startPromise
  }

  shutdown(): void {
    this.stopped = true
    this.rejectAll(new Error('Codex app-server stopped'))
    this.proc?.kill('SIGTERM')
    this.proc = null
  }

  private async start(): Promise<void> {
    this.stopped = false
    const proc = spawn('codex', [
      'app-server',
      '--listen',
      'stdio://',
      '--enable',
      'default_mode_request_user_input',
    ], {
      env: getCliEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.proc = proc
    this.buffer = ''

    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk) => this.onStdout(chunk))
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk) => {
      const text = String(chunk).trim()
      if (text) log.warn('app_server_stderr', { text })
    })
    proc.on('error', (err) => {
      log.error('app_server_start_failed', { error: err.message })
      this.rejectAll(err)
      this.emit('error', err)
    })
    proc.on('exit', (code, signal) => {
      log.warn('app_server_exited', { code, signal })
      this.proc = null
      const err = new Error(`Codex app-server exited code=${code} signal=${signal}`)
      this.rejectAll(err)
      this.emit('exit', code, signal)
      if (!this.stopped && !this.didRestart) {
        this.didRestart = true
        this.ensureStarted().catch((restartErr) => this.emit('error', restartErr))
      }
    })

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out starting Codex app-server')), 5000)
      proc.once('spawn', () => {
        clearTimeout(timer)
        resolve()
      })
      proc.once('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })

    try {
      await this.request('initialize', {
        clientInfo: { name: 'Solus', title: null, version: '0.7.0' },
        capabilities: { experimentalApi: true, optOutNotificationMethods: null },
      }, 15_000)
    } catch (err) {
      log.warn('app_server_initialize_failed', { error: err instanceof Error ? err.message : String(err) })
    }

    // Point Codex at the app-bundled skills via the live API rather than config,
    // so every turn sees the Solus plugin's skills directory.
    try {
      await this.request('skills/extraRoots/set', {
        extraRoots: [join(SOLUS_PLUGINS_DIR, 'skills')],
      }, 15_000)
    } catch (err) {
      log.warn('skills_extra_roots_set_failed', { error: err instanceof Error ? err.message : String(err) })
    }
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk
    for (;;) {
      const idx = this.buffer.indexOf('\n')
      if (idx === -1) return
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (!line) continue
      try {
        // SAFETY: Codex app-server stdout is the generated JSON-RPC protocol transport.
        this.onMessage(JSON.parse(line) as JsonRpcMessage)
      } catch {
        log.warn('non_json_stdout_ignored', { line })
      }
    }
  }

  private onMessage(message: JsonRpcMessage): void {
    if ('id' in message && ('result' in message || 'error' in message)) {
      this.onResponse(message)
      return
    }
    if ('method' in message && 'id' in message) {
      this.emit('server-request', message)
      return
    }
    if ('method' in message) {
      this.emit('notification', message)
    }
  }

  private onResponse(response: JsonRpcResponse): void {
    const pending = this.pending.get(response.id)
    if (!pending) return
    this.pending.delete(response.id)
    clearTimeout(pending.timer)
    if (response.error) {
      pending.reject(new CodexRpcError(
        response.error.message,
        response.error.code,
        response.error.data,
      ))
    } else {
      pending.resolve(response.result)
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
  }
}

let sharedClient: CodexAppServerClient | null = null

export function getCodexAppServerClient(): CodexAppServerClient {
  if (!sharedClient) sharedClient = new CodexAppServerClient()
  return sharedClient
}

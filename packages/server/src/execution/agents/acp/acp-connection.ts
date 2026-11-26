import type { Readable, Writable } from 'node:stream'
import { z } from 'zod'

/** A line longer than this is not a protocol message: the connection fails. */
const MAX_LINE_BYTES = 16 * 1024 * 1024
const STDERR_TAIL_LINES = 40

/** An error answer to one request, as the agent sent it. */
export class AcpRequestError extends Error {
  constructor(readonly method: string, readonly code: number, message: string, readonly data?: z.core.util.JSONType) {
    super(message)
    this.name = 'AcpRequestError'
  }
}

/** The connection ended: the agent exited, or it broke the protocol. */
export class AcpConnectionClosedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AcpConnectionClosedError'
  }
}

const messageSchema = z.looseObject({
  jsonrpc: z.literal('2.0').optional(),
  id: z.union([z.number(), z.string()]).nullish(),
  method: z.string().optional(),
  params: z.json().optional(),
  result: z.json().optional(),
  error: z.looseObject({ code: z.number(), message: z.string(), data: z.json().optional() }).optional(),
})

type JsonValue = z.core.util.JSONType

export interface AcpStreams {
  stdin: Writable
  stdout: Readable
  stderr?: Readable | null
}

export interface AcpConnectionHandlers {
  /** A notification from the agent, such as `session/update`. */
  onNotification(method: string, params: JsonValue | undefined): void
  /** A request from the agent, such as `session/request_permission`. A throw answers with an error. */
  onRequest(method: string, params: JsonValue | undefined): Promise<JsonValue>
  /** One line the agent wrote to stderr. */
  onStderrLine?(line: string): void
  /** The connection closed; every request still open was rejected with `error`. */
  onClose?(error: AcpConnectionClosedError): void
}

interface OpenRequest {
  method: string
  resolve(result: JsonValue | undefined): void
  reject(error: Error): void
}

/**
 * JSON-RPC 2.0 over an ACP agent's stdin and stdout, one message per line.
 * It knows no ACP method: the backend gives the methods meaning.
 */
export class AcpConnection {
  private nextId = 1
  private readonly open = new Map<number, OpenRequest>()
  private buffer = ''
  private closedError: AcpConnectionClosedError | null = null
  private readonly stderrTail: string[] = []

  constructor(private readonly streams: AcpStreams, private readonly handlers: AcpConnectionHandlers) {
    streams.stdout.setEncoding('utf8')
    streams.stdout.on('data', (chunk: string) => this.onData(chunk))
    streams.stdout.on('end', () => this.close('The agent closed its output.'))
    streams.stdin.on('error', () => this.close('The agent closed its input.'))
    if (streams.stderr) {
      streams.stderr.setEncoding('utf8')
      let pending = ''
      streams.stderr.on('data', (chunk: string) => {
        const lines = `${pending}${chunk}`.split('\n')
        pending = lines.pop() ?? ''
        if (pending.length > MAX_LINE_BYTES) pending = ''
        for (const line of lines) this.onStderrLine(line.replace(/\r$/, ''))
      })
    }
  }

  get isClosed(): boolean {
    return this.closedError !== null
  }

  /** The last lines the agent wrote to stderr, for an error report. */
  get recentStderr(): string[] {
    return [...this.stderrTail]
  }

  request(method: string, params: JsonValue): Promise<JsonValue | undefined> {
    if (this.closedError) return Promise.reject(this.closedError)
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.open.set(id, { method, resolve, reject })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: JsonValue): void {
    if (this.closedError) return
    this.write({ jsonrpc: '2.0', method, params })
  }

  /** Rejects every open request and stops reading. The caller stops the process. */
  close(reason: string): void {
    if (this.closedError) return
    const error = new AcpConnectionClosedError(reason)
    this.closedError = error
    for (const request of this.open.values()) request.reject(error)
    this.open.clear()
    this.handlers.onClose?.(error)
  }

  private write(message: JsonValue): void {
    if (!this.streams.stdin.writable) {
      this.close('The agent closed its input.')
      return
    }
    this.streams.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private onStderrLine(line: string): void {
    if (!line) return
    this.stderrTail.push(line)
    if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift()
    this.handlers.onStderrLine?.(line)
  }

  private onData(chunk: string): void {
    if (this.closedError) return
    this.buffer += chunk
    let newline: number
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line) this.onLine(line)
      if (this.closedError) return
    }
    if (this.buffer.length > MAX_LINE_BYTES) this.close('The agent sent a protocol line that is too large.')
  }

  private onLine(line: string): void {
    let parsed: z.infer<typeof messageSchema>
    try {
      const result = messageSchema.safeParse(JSON.parse(line))
      // A line that is not JSON-RPC is the agent's own output; it is not a protocol message.
      if (!result.success) return
      parsed = result.data
    } catch {
      return
    }
    const { id, method } = parsed
    if (method !== undefined && id !== undefined && id !== null) {
      void this.answer(id, method, parsed.params)
      return
    }
    if (method !== undefined) {
      this.handlers.onNotification(method, parsed.params)
      return
    }
    // Solus numbers its own requests: any other id answers nothing it sent.
    const requestId = z.number().safeParse(id)
    if (!requestId.success) return
    const request = this.open.get(requestId.data)
    if (!request) return
    this.open.delete(requestId.data)
    if (parsed.error) request.reject(new AcpRequestError(request.method, parsed.error.code, parsed.error.message, parsed.error.data))
    else request.resolve(parsed.result)
  }

  private async answer(id: number | string, method: string, params: JsonValue | undefined): Promise<void> {
    try {
      const result = await this.handlers.onRequest(method, params)
      this.write({ jsonrpc: '2.0', id, result })
    } catch (error) {
      const code = error instanceof AcpRequestError ? error.code : -32603
      this.write({ jsonrpc: '2.0', id, error: { code, message: error instanceof Error ? error.message : String(error) } })
    }
  }
}

/** The JSON-RPC answer for a method the client does not offer. */
export function methodNotFound(method: string): AcpRequestError {
  return new AcpRequestError(method, -32601, `Method not found: ${method}`)
}

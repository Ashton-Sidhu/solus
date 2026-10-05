import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { z } from 'zod'
import type { DeviceControlHolder } from '@solus/contracts/device-types'
import { createLogger } from '../logger'
import { DeviceDomainError } from './device-errors'
import type { AgentDeviceEndpoint } from './device-host'
import { listeningPort } from './device-helpers'

const log = createLogger('devices', 'device-agent-bridge.ts')

/**
 * The guarded path between an agent's `agent-device` CLI and the daemon
 * (plan 016, S01 and stage 6). The CLI is configured with this loopback
 * bridge and a per-binding bridge token, never the daemon's own token. For
 * every request the bridge:
 *
 * - authenticates the bridge token and resolves its binding (session, host, device);
 * - pins the daemon session to that binding and refuses a different device target;
 * - for a mutating command, takes the agent's control lease and checks its
 *   generation before forwarding, so a person's takeover stops agent input;
 * - swaps in the daemon credential, which never leaves the host.
 *
 * It routes; it does not sandbox an agent that already has a shell.
 */

/** agent-device commands that only read. Anything else is treated as a mutation. */
const READ_COMMANDS: ReadonlySet<string> = new Set([
  'snapshot', 'screenshot', 'devices', 'get', 'is', 'find', 'wait', 'logs', 'appstate', 'apps',
  'session', 'diff', 'help', 'version', 'capabilities', 'perf', 'network',
])

const MAX_RPC_BODY_BYTES = 1024 * 1024

const authHeadersSchema = z.object({
  authorization: z.string().optional().catch(undefined),
  'x-agent-device-token': z.string().optional().catch(undefined),
})

/** The daemon's JSON-RPC request. Unknown fields pass through to the daemon unchanged. */
const rpcRequestSchema = z.looseObject({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]).catch(null),
  method: z.string().max(200),
  params: z.looseObject({
    command: z.string().max(200).optional().catch(undefined),
    flags: z.looseObject({
      udid: z.string().optional().catch(undefined),
      serial: z.string().optional().catch(undefined),
    }).optional().catch(undefined),
  }).catch({}),
})
type RpcRequest = z.infer<typeof rpcRequestSchema>

/** A request body up to the limit, or null when it is larger. */
async function readBoundedBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.length
    if (size > MAX_RPC_BODY_BYTES) return null
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export interface DeviceAgentBinding {
  sessionId: string
  deviceHostId: string
  deviceId: string
  platform: 'ios' | 'android'
  /** The agent-device session name pinned for this binding. */
  agentSession: string
  label: string
}

export interface DeviceAgentBridgeDeps {
  /** The daemon endpoint for a device host, or why it is unavailable. */
  endpoint: (deviceHostId: string) => AgentDeviceEndpoint | null
  /** Take or renew the agent's lease. Throws `agent_paused` / `control_busy`. */
  acquire: (binding: DeviceAgentBinding, holder: DeviceControlHolder & { kind: 'agent' }) => number
  /** Begin a mutation under `generation`; call the result when it ends. */
  begin: (binding: DeviceAgentBinding, generation: number, holder: DeviceControlHolder & { kind: 'agent' }) => () => void
}

interface BindingEntry {
  binding: DeviceAgentBinding
  tokenHash: Buffer
}

const hash = (token: string) => createHash('sha256').update(token).digest()

export function agentSessionName(sessionId: string, deviceHostId: string, deviceId: string): string {
  return `solus-${createHash('sha256').update(JSON.stringify([sessionId, deviceHostId, deviceId])).digest('hex').slice(0, 24)}`
}

export function isReadCommand(command: string): boolean {
  return READ_COMMANDS.has(command)
}

export class DeviceAgentBridge {
  private server: Server | null = null
  private port = 0
  private readonly bindings = new Map<string, BindingEntry>()

  constructor(private readonly deps: DeviceAgentBridgeDeps) {}

  get baseUrl(): string | null {
    return this.server ? `http://127.0.0.1:${this.port}` : null
  }

  async start(): Promise<string> {
    if (this.server) return this.baseUrl!
    const server = createServer((req, res) => { void this.handle(req, res) })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    this.port = listeningPort(server)
    this.server = server
    return this.baseUrl!
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.bindings.clear()
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  /** Issue a token for one binding. Reissuing for the same binding replaces the old token. */
  bind(binding: DeviceAgentBinding): string {
    for (const [key, entry] of this.bindings) {
      if (entry.binding.agentSession === binding.agentSession) this.bindings.delete(key)
    }
    const token = randomBytes(24).toString('base64url')
    this.bindings.set(binding.agentSession, { binding, tokenHash: hash(token) })
    return token
  }

  /** Revoke bindings: a session closed its device, access was turned off, a host changed. */
  revoke(predicate: (binding: DeviceAgentBinding) => boolean): void {
    for (const [key, entry] of this.bindings) if (predicate(entry.binding)) this.bindings.delete(key)
  }

  private authenticate(req: IncomingMessage): BindingEntry | null {
    const headers = authHeadersSchema.parse(req.headers)
    const header = headers.authorization?.toLowerCase().startsWith('bearer ')
      ? headers.authorization.slice(7)
      : headers['x-agent-device-token'] ?? ''
    if (!header) return null
    const candidate = hash(header)
    for (const entry of this.bindings.values()) {
      if (timingSafeEqual(entry.tokenHash, candidate)) return entry
    }
    return null
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '/').split('?')[0] ?? '/'
    if (req.method === 'GET' && path === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, service: 'solus-device-bridge' }))
      return
    }
    const entry = this.authenticate(req)
    if (!entry) {
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'This device binding is no longer valid. Call device_open again.' } }))
      return
    }
    const endpoint = this.deps.endpoint(entry.binding.deviceHostId)
    if (!endpoint) {
      res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Agent device access is not running on this host.' } }))
      return
    }
    if (req.method === 'POST' && path === '/rpc') {
      await this.rpc(req, res, entry.binding, endpoint)
      return
    }
    if (path.startsWith('/upload') || path.startsWith('/artifacts')) {
      this.forward(req, res, endpoint, path)
      return
    }
    res.writeHead(404).end()
  }

  private async rpc(req: IncomingMessage, res: ServerResponse, binding: DeviceAgentBinding, endpoint: AgentDeviceEndpoint): Promise<void> {
    const body = await readBoundedBody(req)
    if (body === null) {
      res.writeHead(413).end()
      return
    }
    let parsed: z.ZodSafeParseResult<RpcRequest>
    try {
      parsed = rpcRequestSchema.safeParse(JSON.parse(body))
    } catch {
      res.writeHead(400).end()
      return
    }
    if (!parsed.success) {
      res.writeHead(400).end()
      return
    }
    const request = parsed.data
    const fail = (code: number, message: string, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code, message } }))
    }
    const isCommand = request.method === 'agent_device.command' || request.method === 'agent-device.command'
    const named = request.params.flags?.udid ?? request.params.flags?.serial
    if (isCommand && named !== undefined && named !== binding.deviceId) {
      fail(-32602, `This binding drives ${binding.deviceId}. Call device_open for another device.`)
      return
    }
    // Commands always run in the binding's own daemon session, with the daemon's credential.
    const params: RpcRequest['params'] & { token: string; session?: string } = { ...request.params, token: endpoint.token }
    if (isCommand) params.session = binding.agentSession
    const end = this.guard(binding, isCommand ? request.params.command ?? '' : request.method, isCommand)
    if (end instanceof DeviceDomainError) {
      fail(-32001, end.detail)
      return
    }
    try {
      await this.forwardRpc(res, binding, endpoint, JSON.stringify({ ...request, params }), fail)
    } finally {
      end?.()
    }
  }

  /** Take the agent's lease for a mutation. Reads pass without one. */
  private guard(binding: DeviceAgentBinding, name: string, isCommand: boolean): (() => void) | null | DeviceDomainError {
    const mutating = isCommand ? !isReadCommand(name) : name.includes('install')
    if (!mutating) return null
    const holder = { kind: 'agent' as const, sessionId: binding.sessionId, label: binding.label }
    try {
      const generation = this.deps.acquire(binding, holder)
      return this.deps.begin(binding, generation, holder)
    } catch (cause) {
      return cause instanceof DeviceDomainError ? cause : new DeviceDomainError('control_busy', 'Control of this device is not available.')
    }
  }

  private forwardRpc(res: ServerResponse, binding: DeviceAgentBinding, endpoint: AgentDeviceEndpoint, json: string, fail: (code: number, message: string, status?: number) => void): Promise<void> {
    const payload = Buffer.from(json)
    return new Promise<void>((resolve) => {
      const upstream = httpRequest(`${endpoint.baseUrl}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': payload.length, authorization: `Bearer ${endpoint.token}`, 'x-agent-device-token': endpoint.token },
      }, (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, { 'content-type': upstreamRes.headers['content-type'] ?? 'application/json' })
        upstreamRes.pipe(res)
        upstreamRes.once('end', resolve)
        upstreamRes.once('error', () => resolve())
      })
      upstream.once('error', (error) => {
        log.warn('device_agent_bridge_upstream_failed', { deviceHostId: binding.deviceHostId, error: error.message })
        if (!res.headersSent) fail(-32000, 'Agent device tools did not answer. Retry, or call device_open again.', 502)
        resolve()
      })
      upstream.end(payload)
    })
  }

  private forward(req: IncomingMessage, res: ServerResponse, endpoint: AgentDeviceEndpoint, path: string): void {
    const search = (req.url ?? '').includes('?') ? `?${(req.url ?? '').split('?')[1]}` : ''
    const headers = { ...req.headers, authorization: `Bearer ${endpoint.token}`, 'x-agent-device-token': endpoint.token }
    delete headers.host
    const upstream = httpRequest(`${endpoint.baseUrl}${path}${search}`, { method: req.method, headers }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
      upstreamRes.pipe(res)
    })
    upstream.once('error', () => { if (!res.headersSent) res.writeHead(502).end() })
    req.pipe(upstream)
  }
}

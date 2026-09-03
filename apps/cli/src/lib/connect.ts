import { spawn } from 'child_process'
import { randomBytes } from 'crypto'
import { z } from 'zod'
import { io, type Socket } from 'socket.io-client'
import {
  requestDeviceCode,
  waitForDeviceApproval,
  type DeviceCodeGrant,
} from '@solus/client-core/device-authorization'
import {
  enrollmentTicketResponseSchema,
  uplinkStatusSchema,
  type UplinkEnrollmentTicket,
  type UplinkStatus,
} from '@solus/contracts/uplink'
import { hostForUrl } from '@solus/contracts/entrypoint'
import { installCloudflared } from './cloudflared'
import {
  isProcessAlive,
  localConnectHost,
  readLockFile,
  runtimePaths,
  type RuntimePaths,
} from './runtime'

export const CLI_DEVICE_CLIENT_ID = 'solus-cli'
export const DEFAULT_CLOUD_ORIGIN = 'https://app.solus.sh'

export interface ConnectOptions {
  dataDir: string
  cloudUrl?: string
  noOpen: boolean
}

export interface ConnectReporter {
  deviceCode(grant: DeviceCodeGrant): void
  stage(message: string): void
}

export function resolveCloudOrigin(value: string | undefined): string {
  const candidate = value?.trim() || process.env.SOLUS_CLOUD_URL?.trim() || DEFAULT_CLOUD_ORIGIN
  const url = new URL(candidate)
  const isLoopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new Error('Solus Cloud must use HTTPS unless it points at loopback')
  }
  return url.origin
}

export async function connectHost(options: ConnectOptions, reporter: ConnectReporter): Promise<UplinkStatus> {
  const paths = runtimePaths(options.dataDir)
  const current = await withLocalHost(paths, (api) => api.uplinkStatus())

  reporter.stage('Checking cloudflared')
  await installCloudflared({ dataDir: options.dataDir })
  reporter.stage('cloudflared is ready')
  if (current.linked) return current

  const cloudOrigin = resolveCloudOrigin(options.cloudUrl)
  const sessionToken = await authorizeCli(cloudOrigin, options.noOpen, reporter)
  try {
    const ticket = await issueEnrollmentTicket(cloudOrigin, sessionToken)
    return await withLocalHost(paths, (api) => api.uplinkLink(ticket))
  } finally {
    await signOutCloudSession(cloudOrigin, sessionToken)
  }
}

export async function connectStatus(dataDir: string): Promise<UplinkStatus> {
  return withLocalHost(runtimePaths(dataDir), (api) => api.uplinkStatus())
}

export async function disconnectHost(dataDir: string): Promise<UplinkStatus> {
  return withLocalHost(runtimePaths(dataDir), async (api) => {
    const current = await api.uplinkStatus()
    return current.linked ? api.uplinkUnlink() : current
  })
}

async function authorizeCli(
  cloudOrigin: string,
  noOpen: boolean,
  reporter: ConnectReporter,
): Promise<string> {
  const grant = await requestDeviceCode({
    cloudOrigin,
    clientId: CLI_DEVICE_CLIENT_ID,
    fetch,
    now: Date.now,
  })
  reporter.deviceCode(grant)
  if (!noOpen && !process.env.SSH_CONNECTION && !process.env.SSH_TTY) openBrowser(grant.verificationUrl)
  const result = await waitForDeviceApproval(
    grant,
    { cloudOrigin, fetch, now: Date.now, sleep },
    new AbortController().signal,
  )
  if (result.end !== 'approved') throw new Error(result.message)
  reporter.stage('Account approved')
  return result.sessionToken
}

async function issueEnrollmentTicket(cloudOrigin: string, sessionToken: string): Promise<UplinkEnrollmentTicket> {
  const response = await fetch(`${cloudOrigin}/v1/enrollment-tickets`, {
    method: 'POST',
    headers: { authorization: `Bearer ${sessionToken}`, accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`Solus Cloud could not issue an enrollment ticket (${response.status})`)
  const parsed = enrollmentTicketResponseSchema.safeParse(await response.json().catch(() => null))
  if (!parsed.success) throw new Error('Solus Cloud returned an invalid enrollment ticket')
  return { ...parsed.data, directoryUrl: cloudOrigin }
}

async function signOutCloudSession(cloudOrigin: string, sessionToken: string): Promise<void> {
  try {
    await fetch(`${cloudOrigin}/api/auth/sign-out`, {
      method: 'POST',
      headers: { authorization: `Bearer ${sessionToken}` },
    })
  } catch {
    // The short-lived setup client keeps no local copy. Server-side expiry remains the fallback.
  }
}

interface LocalHostApi {
  uplinkStatus(): Promise<UplinkStatus>
  uplinkLink(request: UplinkEnrollmentTicket): Promise<UplinkStatus>
  uplinkUnlink(): Promise<UplinkStatus>
}

async function withLocalHost<T>(paths: RuntimePaths, run: (api: LocalHostApi) => Promise<T>): Promise<T> {
  const lock = readLockFile(paths.lockFile)
  if (!lock || !isProcessAlive(lock.pid)) {
    throw new Error('The Solus server is not running. Start it with `solus start`, then run this command again.')
  }
  const serverUrl = `http://${hostForUrl(localConnectHost(lock.host))}:${lock.port}`
  const socket = io(serverUrl, {
    path: '/ws',
    transports: ['websocket'],
    reconnection: false,
    auth: { clientInstanceId: `cli-${randomBytes(12).toString('hex')}` },
  })
  try {
    await waitForSocket(socket)
    const api: LocalHostApi = {
      uplinkStatus: () => invokeUplink(socket, 'uplinkStatus', []),
      uplinkLink: (request) => invokeUplink(socket, 'uplinkLink', [request]),
      uplinkUnlink: () => invokeUplink(socket, 'uplinkUnlink', []),
    }
    return await run(api)
  } finally {
    socket.disconnect()
  }
}

function waitForSocket(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('Timed out connecting to the local Solus server')), 10_000)
    timeout.unref?.()
    const finish = (error?: Error) => {
      clearTimeout(timeout)
      socket.off('connect', onConnect)
      socket.off('connect_error', onError)
      if (error) reject(error)
      else resolve()
    }
    const onConnect = () => finish()
    const onError = (error: Error) => finish(new Error(`The local Solus server refused the CLI connection: ${error.message}`))
    socket.once('connect', onConnect)
    socket.once('connect_error', onError)
  })
}

type UplinkRpcMethod = 'uplinkStatus' | 'uplinkLink' | 'uplinkUnlink'

const uplinkRpcEnvelopeSchema = z.object({
  result: z.unknown().optional(),
  error: z.object({ message: z.string().optional() }).optional(),
})
type UplinkRpcEnvelopeInput = z.input<typeof uplinkRpcEnvelopeSchema>

function invokeUplink(socket: Socket, method: UplinkRpcMethod, args: unknown[]): Promise<UplinkStatus> {
  return new Promise((resolve, reject) => {
    const requestId = randomBytes(8).toString('hex')
    socket.emit('rpc', requestId, method, args, (response: UplinkRpcEnvelopeInput) => {
      const envelope = uplinkRpcEnvelopeSchema.safeParse(response)
      if (!envelope.success) return reject(new Error(`The ${method} response was invalid`))
      if (envelope.data.error) return reject(new Error(envelope.data.error.message ?? `${method} failed`))
      const status = uplinkStatusSchema.safeParse(envelope.data.result)
      if (!status.success) reject(new Error(`The ${method} result was invalid`))
      else resolve(status.data)
    })
  })
}


function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'))
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function openBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open'
  const child = spawn(command, [url], { detached: true, stdio: 'ignore' })
  child.once('error', () => {})
  child.unref()
}

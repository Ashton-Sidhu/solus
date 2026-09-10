/**
 * A one-shot RPC call to the Solus server running on this machine. A loopback
 * socket is admitted as the local owner with no credential
 * (`packages/server/src/server/trusted-requesters.ts`), which is exactly the
 * trust `solus update`/`solus status` need: whoever can run this CLI already
 * has the same filesystem access as the server.
 */
import { randomBytes } from 'crypto'
import { io, type Socket } from 'socket.io-client'
import { z } from 'zod'
import { hostForUrl } from '@solus/contracts/entrypoint'
import { isProcessAlive, localConnectHost, readLockFile, type RuntimePaths } from './runtime'

const rpcEnvelopeSchema = z.object({
  result: z.unknown().optional(),
  error: z.object({ message: z.string().optional() }).optional(),
})
type RpcEnvelopeInput = z.input<typeof rpcEnvelopeSchema>

export function requireRunningServerUrl(paths: RuntimePaths): string {
  const lock = readLockFile(paths.lockFile)
  if (!lock || !isProcessAlive(lock.pid)) {
    throw new Error('The Solus server is not running. Start it with `solus service start` or `solus start`, then try again.')
  }
  return `http://${hostForUrl(localConnectHost(lock.host))}:${lock.port}`
}

function connectLocalSocket(serverUrl: string): Promise<Socket> {
  const socket = io(serverUrl, {
    path: '/ws',
    transports: ['websocket'],
    reconnection: false,
    auth: { clientInstanceId: `cli-${randomBytes(12).toString('hex')}` },
  })
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('Timed out connecting to the local Solus server')), 10_000)
    timeout.unref?.()
    const finish = (error?: Error) => {
      clearTimeout(timeout)
      socket.off('connect', onConnect)
      socket.off('connect_error', onError)
      if (error) { socket.disconnect(); reject(error) }
      else resolve(socket)
    }
    const onConnect = () => finish()
    const onError = (error: Error) => finish(new Error(`The local Solus server refused the CLI connection: ${error.message}`))
    socket.once('connect', onConnect)
    socket.once('connect_error', onError)
  })
}

function invoke<T>(socket: Socket, method: string, args: unknown[]): Promise<T> {
  return new Promise((resolve, reject) => {
    const requestId = randomBytes(8).toString('hex')
    const timeout = setTimeout(() => reject(new Error(`The ${method} request timed out`)), 15_000)
    socket.emit('rpc', requestId, method, args, (response: RpcEnvelopeInput) => {
      clearTimeout(timeout)
      const envelope = rpcEnvelopeSchema.safeParse(response)
      if (!envelope.success) return reject(new Error(`The ${method} response was invalid`))
      if (envelope.data.error) return reject(new Error(envelope.data.error.message ?? `${method} failed`))
      // SAFETY: The result carries the invoked method's return type, which the
      // wire cannot prove and callers' generic parameter already assumed pre-parse.
      resolve(envelope.data.result as T)
    })
  })
}

/** Opens one socket, runs `body`, and always disconnects afterward. */
export async function withLocalRpc<T>(serverUrl: string, body: (call: <R>(method: string, args?: unknown[]) => Promise<R>) => Promise<T>): Promise<T> {
  const socket = await connectLocalSocket(serverUrl)
  try {
    return await body((method, args = []) => invoke(socket, method, args))
  } finally {
    socket.disconnect()
  }
}

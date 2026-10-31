/**
 * A one-shot RPC call to the Solus server running on this machine. A loopback
 * socket is admitted as the local owner with no credential
 * (`packages/server/src/transport/trusted-requesters.ts`), which is exactly the
 * trust `solus update`/`solus status` need: whoever can run this CLI already
 * has the same filesystem access as the server.
 */
import { randomBytes } from 'crypto'
import { dialHostSocket } from '@solus/client-core/host-socket'
import { hostForUrl } from '@solus/contracts/entrypoint'
import { isProcessAlive, localConnectHost, readLockFile, type RuntimePaths } from './runtime'

export function requireRunningServerUrl(paths: RuntimePaths): string {
  const lock = readLockFile(paths.lockFile)
  if (!lock || !isProcessAlive(lock.pid)) {
    throw new Error('The Solus server is not running. Start it with `solus service start` or `solus start`, then try again.')
  }
  return `http://${hostForUrl(localConnectHost(lock.host))}:${lock.port}`
}

export async function withLocalRpc<T>(serverUrl: string, body: (call: <R>(method: string, args?: unknown[]) => Promise<R>) => Promise<T>): Promise<T> {
  const dialed = await dialHostSocket(serverUrl, { clientInstanceId: `cli-${randomBytes(12).toString('hex')}` }, { timeoutMs: 10_000 })
  if (!dialed.ok) throw new Error(`The local Solus server refused the CLI connection: ${dialed.message}`)
  const socket = dialed.socket
  try {
    return await body(async <R>(method: string, args: unknown[] = []) => {
      const envelope = await socket.call(method, args, 15_000)
      if (envelope.error) throw new Error(envelope.error.message ?? `${method} failed`)
      // SAFETY: The result carries the invoked method's return type, which the
      // wire cannot prove and callers' generic parameter already assumed pre-parse.
      return envelope.result as R
    })
  } finally {
    socket.close()
  }
}

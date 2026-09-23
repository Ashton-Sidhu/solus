/** Used by solus-cloud's isolated OAuth browser proof. Synthetic accounts and an isolated mock host only. */
import { io, type Socket } from 'socket.io-client'
import { z } from 'zod'
import { bootLabHost } from '../packages/lab/src/host'
import type { RpcMethod } from '@solus/contracts/rpc'

interface ProofOptions {
  origin: string
  sessionToken: string
  hostId: string
  hostToken: string
  entry: string
}

const grantSchema = z.object({ grant: z.string() })
const ticketSchema = z.object({ ticket: z.string() })
const statusSchema = z.object({ connected: z.boolean() })
interface StatusReply { result?: { connected: boolean }; error?: { message: string } }

export async function accountIntegrationHostProof(options: ProofOptions) {
  const host = await bootLabHost({
    flavor: 'personal', hostId: options.hostId, runnerOf: 'unused', entry: options.entry,
    issuer: {
      issuer: options.origin, jwksUrl: `${options.origin}/api/auth/jwks`,
      attachHostToOrganization: () => {},
      issueManagedLink: (hostId, proxiedPort) => ({
        link: { hostId, issuer: options.origin, jwksUrl: `${options.origin}/api/auth/jwks`, directoryUrl: options.origin, hostname: 'proof.invalid', proxiedPort, connectionGeneration: 1 },
        hostToken: options.hostToken, connectorToken: 'proof-connector',
      }),
    },
  })
  let socket: Socket | null = null
  try {
    const response = await fetch(`${options.origin}/v1/hosts/${options.hostId}/grant`, { method: 'POST', headers: { authorization: `Bearer ${options.sessionToken}` } })
    if (!response.ok) throw new Error(`Cloud grant failed: ${response.status}`)
    const { grant } = grantSchema.parse(await response.json())
    const ticketResponse = await fetch(`${host.tunnelUrl}/auth/ws-ticket`, { method: 'POST', headers: { authorization: `Bearer ${grant}`, 'content-type': 'application/json' }, body: '{}' })
    if (!ticketResponse.ok) throw new Error(`Host ticket failed: ${ticketResponse.status}`)
    const { ticket } = ticketSchema.parse(await ticketResponse.json())
    const client = io(host.tunnelUrl, { path: '/ws', transports: ['websocket'], reconnection: false, auth: { ticket, clientInstanceId: `account-proof-${crypto.randomUUID()}` } })
    socket = client
    await new Promise<void>((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject) })
    async function status(method: RpcMethod): Promise<boolean> {
      const answer = await new Promise<unknown>((resolve, reject) => {
        client.timeout(15_000).emit('rpc', crypto.randomUUID(), method, [], (error: Error | null, result: StatusReply) => error ? reject(error) : resolve(result))
      })
      const parsed = z.object({ result: statusSchema.optional(), error: z.object({ message: z.string() }).optional() }).parse(answer)
      if (parsed.error) throw new Error(parsed.error.message)
      return parsed.result?.connected ?? false
    }
    return { host, status, close: async () => { client.close(); await host.stop() } }
  } catch (error) {
    socket?.close()
    await host.stop()
    throw error
  }
}

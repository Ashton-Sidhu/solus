/** Used by solus-cloud's isolated OAuth browser proof. Synthetic accounts and an isolated mock host only. */
import { createHash, randomBytes } from 'node:crypto'
import { io, type Socket } from 'socket.io-client'
import { z } from 'zod'
import { bootLabHost } from '../packages/lab/src/host'
import { SOLUS_CLIENT_IDS } from '@solus/contracts/auth/clients'
import type { RpcMethod } from '@solus/contracts/rpc'
import { hostAudience } from '@solus/contracts/uplink'

interface ProofOptions {
  origin: string
  /** The person's website session as a `cookie` header; it approves the desktop's sign-in. */
  sessionCookie: string
  hostId: string
  /** The one-time ticket (`hct_`) the control plane keeps for this host's link; the host registers its own key with it. */
  credentialTicket: string
  entry: string
}

const tokenSchema = z.object({ access_token: z.string().optional(), refresh_token: z.string().optional(), error: z.string().optional(), error_description: z.string().optional() })
const authorizeSchema = z.object({ url: z.string() })
const ticketSchema = z.object({ ticket: z.string() })
const statusSchema = z.object({ connected: z.boolean() })
interface StatusReply { result?: { connected: boolean }; error?: { message: string } }

const DESKTOP_REDIRECT = 'http://127.0.0.1:53123/callback'

/**
 * The person's access token for one host, as the desktop gets it
 * (docs/adr/0001-standard-authentication.md §2.2 rule 1): authorization code + PKCE
 * approved by the website session, then a refresh that names the host's resource.
 */
async function personAccessToken(options: ProofOptions): Promise<string> {
  const token = async (form: Record<string, string>) => {
    const response = await fetch(`${options.origin}/api/auth/oauth2/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) })
    return tokenSchema.parse(await response.json())
  }
  const verifier = randomBytes(32).toString('base64url')
  const query = new URLSearchParams({
    response_type: 'code', client_id: SOLUS_CLIENT_IDS.desktop, redirect_uri: DESKTOP_REDIRECT, scope: 'openid profile email offline_access',
    state: randomBytes(8).toString('base64url'), code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
  })
  const authorized = await fetch(`${options.origin}/api/auth/oauth2/authorize?${query}`, { headers: { cookie: options.sessionCookie, accept: 'application/json' }, redirect: 'manual' })
  const answer = authorizeSchema.safeParse(await authorized.json().catch(() => null))
  const redirect = authorized.headers.get('location') ?? (answer.success ? answer.data.url : '')
  const code = redirect ? new URL(redirect, options.origin).searchParams.get('code') ?? '' : ''
  const signedIn = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: DESKTOP_REDIRECT, client_id: SOLUS_CLIENT_IDS.desktop })
  if (!signedIn.refresh_token) throw new Error(`Desktop sign-in failed: ${signedIn.error}: ${signedIn.error_description}`)
  const forHost = await token({ grant_type: 'refresh_token', refresh_token: signedIn.refresh_token, client_id: SOLUS_CLIENT_IDS.desktop, resource: hostAudience(options.hostId) })
  if (!forHost.access_token) throw new Error(`No access token for the host: ${forHost.error}: ${forHost.error_description}`)
  return forHost.access_token
}

export async function accountIntegrationHostProof(options: ProofOptions) {
  // Booted from an environment link, as a provisioned machine is: the host makes its own
  // key and registers it at the real control plane with the ticket, so it can trade the
  // person's token for a delegation. The link names no organization: Alice's own host.
  const host = await bootLabHost({
    flavor: 'managed', managedLink: 'env', hostId: options.hostId, entry: options.entry,
    issuer: {
      issuer: options.origin, jwksUrl: `${options.origin}/api/auth/jwks`,
      issueManagedLink: (hostId, proxiedPort) => ({
        link: { hostId, issuer: options.origin, jwksUrl: `${options.origin}/api/auth/jwks`, directoryUrl: options.origin, hostname: 'proof.invalid', proxiedPort, connectionGeneration: 1 },
        credentialTicket: options.credentialTicket,
      }),
    },
  })
  let socket: Socket | null = null
  try {
    const accessToken = await personAccessToken(options)
    const ticketResponse = await fetch(`${host.tunnelUrl}/auth/ws-ticket`, { method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' }, body: '{}' })
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

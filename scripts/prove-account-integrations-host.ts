/** Used by solus-cloud's isolated OAuth browser proof. Synthetic accounts and an isolated mock host only. */
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dialHostSocket, type DialedHostSocket } from '@solus/client-core/host-socket'
import { z } from 'zod'
import { bootLabHost } from '../packages/lab/src/host'
import { SOLUS_CLIENT_IDS } from '@solus/contracts/auth/clients'
import type { RpcMethod } from '@solus/contracts/rpc'
import { LINK_CODE_ENV, hostAudience, hostRegistrationSchema } from '@solus/contracts/uplink'

interface ProofOptions {
  origin: string
  /** The person's website session as a `cookie` header; it approves the desktop's sign-in. */
  sessionCookie: string
  /** A personal link code of the person's account (`<ticket>@<control plane host>`); the host enrolls with it at boot. */
  linkCode: string
  entry: string
}

const registrationRecordSchema = z.object({ registration: hostRegistrationSchema })

const tokenSchema = z.object({ access_token: z.string().optional(), refresh_token: z.string().optional(), error: z.string().optional(), error_description: z.string().optional() })
const authorizeSchema = z.object({ url: z.string() })
const statusSchema = z.object({ connected: z.boolean() })

const DESKTOP_REDIRECT = 'http://127.0.0.1:53123/callback'

/**
 * The person's access token for one host, as the desktop gets it
 * (docs/adr/0001-standard-authentication.md §2.2 rule 1): authorization code + PKCE
 * approved by the website session, then a refresh that names the host's resource.
 */
async function personAccessToken(options: ProofOptions, hostId: string): Promise<string> {
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
  const forHost = await token({ grant_type: 'refresh_token', refresh_token: signedIn.refresh_token, client_id: SOLUS_CLIENT_IDS.desktop, resource: hostAudience(hostId) })
  if (!forHost.access_token) throw new Error(`No access token for the host: ${forHost.error}: ${forHost.error_description}`)
  return forHost.access_token
}

export async function accountIntegrationHostProof(options: ProofOptions) {
  // Booted with a link code in its environment, as a machine that enrolls at boot is
  // (plans/034-one-cloud-machine-kind.md §3): the host makes its own key and enrolls at
  // the real control plane with the ticket before it listens, so it can trade the
  // person's token for a delegation. The ticket is a personal one: Alice's own host.
  const host = await bootLabHost({ flavor: 'personal', unregistered: true, entry: options.entry, environment: { [LINK_CODE_ENV]: options.linkCode } })
  let socket: DialedHostSocket | null = null
  try {
    // The control plane named the host when it enrolled.
    const { hostId } = registrationRecordSchema.parse(JSON.parse(readFileSync(join(host.dataDir, 'host-registration.json'), 'utf8'))).registration
    // The person's access token is the socket's one credential (plan §3 rule 4).
    const accessToken = await personAccessToken(options, hostId)
    const dialed = await dialHostSocket(host.tunnelUrl, { credential: { kind: 'access-token', token: accessToken }, clientInstanceId: `account-proof-${crypto.randomUUID()}` })
    if (!dialed.ok) throw new Error(`The host refused the socket: ${dialed.code ?? dialed.message}`)
    const client = dialed.socket
    socket = client
    async function status(method: RpcMethod): Promise<boolean> {
      const answer = await client.call(method, [], 15_000)
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

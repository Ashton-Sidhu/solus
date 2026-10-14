import { z } from 'zod'
import { OAuthSession, type BrowserAuthorizer, type StoredGrant, type TokenStore } from '@solus/client-core/oauth-session'
import { SOLUS_CLIENT_IDS } from '@solus/contracts/auth/clients'
import { enrollmentTicketResponseSchema, type UplinkStatus } from '@solus/contracts/uplink'
import { LabClient } from './client'
import { accountCall, cookieOf, type CloudPersona, type LocalCloudStack } from './local-cloud'

/**
 * Headless sign-in to the local cloud (cloud mode), with the real protocol and no
 * browser (docs/adr/0001-standard-authentication.md §2.2 rule 1). The person signs in
 * on the website with email and password over HTTP; the client is client-core's own
 * `OAuthSession` as `solus-desktop`. Its browser step is the only Lab part: it calls the
 * authorize endpoint with the website's cookie and takes the `code` from the redirect
 * to the loopback address, which nobody needs to listen on.
 */

/** A store in memory: one Lab sign-in lives as long as its scenario. */
function memoryStore(): TokenStore {
  let grant: StoredGrant | null = null
  return { load: () => grant, save: (next) => { grant = next }, clear: () => { grant = null } }
}

const authorizeAnswerSchema = z.object({ url: z.string().min(1) })

/** Each client's registered callback (ADR 0001 §3.5). Desktop: any port, as the provider lets only a loopback port change (RFC 8252 §7.3). */
const REDIRECT_URIS = { desktop: 'http://127.0.0.1:53999/callback', mobile: 'solus://auth/callback' } as const
export type LabSignInClient = keyof typeof REDIRECT_URIS

/** The browser step: the website session approves, and the redirect's address is the callback. */
function cookieAuthorizer(origin: string, cookie: string, redirectUri: string): BrowserAuthorizer {
  return {
    async start() {
      return {
        redirectUri,
        async complete(authorizeUrl) {
          const response = await fetch(authorizeUrl, { headers: { cookie, accept: 'application/json', connection: 'close' }, redirect: 'manual' })
          const location = response.headers.get('location') ?? authorizeAnswerSchema.safeParse(await response.json().catch(() => null)).data?.url
          if (!location) throw new Error(`The authorize endpoint answered ${response.status} with no redirect`)
          const callback = new URL(location, origin)
          if (!callback.href.startsWith(redirectUri)) throw new Error(`The authorize endpoint sent the browser to ${callback.origin}${callback.pathname}, not the callback`)
          return callback
        },
        cancel() {},
      }
    },
  }
}

export interface SignedIn {
  persona: CloudPersona
  oauth: OAuthSession
  clientId: string
  /** What the client keeps: its refresh token, which a scenario may present by hand. */
  store: TokenStore
  /** The website session that approved the sign-in. */
  websiteCookie: string
  /** The status of each revocation request the client sent (`signOut`). */
  revocations: number[]
}

/** Signs a persona in: a website session by password, then authorization code + PKCE as `solus-desktop` (or `solus-mobile`). */
export async function signIn(stack: LocalCloudStack, persona: CloudPersona, client: LabSignInClient = 'desktop'): Promise<SignedIn> {
  const website = await accountCall(stack.origin, '/api/auth/sign-in/email', { body: { email: persona.email, password: persona.password } })
  if (!website.ok) throw new Error(`${persona.name}'s website sign-in answered ${website.status}: ${await website.text()}`)
  const websiteCookie = cookieOf(website)
  const store = memoryStore()
  const revocations: number[] = []
  const oauth = new OAuthSession({
    cloudOrigin: stack.origin,
    clientId: SOLUS_CLIENT_IDS[client],
    store,
    authorizer: cookieAuthorizer(stack.origin, websiteCookie, REDIRECT_URIS[client]),
    fetch: async (input, init) => {
      const response = await fetch(input, init)
      if (new URL(String(input)).pathname.endsWith('/oauth2/revoke')) revocations.push(response.status)
      return response
    },
    now: () => Date.now(),
  })
  const end = await oauth.signIn()
  if (end !== 'approved') throw new Error(`${persona.name}'s sign-in ended ${end}`)
  return { persona, oauth, clientId: SOLUS_CLIENT_IDS[client], store, websiteCookie, revocations }
}

/** Where a client reaches one host: its ordinary listener, and its proxied (tunnel) listener. */
export interface HostAddress {
  localUrl: string
  tunnelUrl: string
}

/** A client on the host's ordinary listener: the trusted local owner, as the desktop's own window is. */
export function localOwnerClient(host: HostAddress, persona: CloudPersona): LabClient {
  return new LabClient({
    persona: { id: persona.name.toLowerCase(), kind: 'host-owner', userId: persona.userId, displayName: persona.name },
    hostUrl: host.localUrl,
    hostId: 'unregistered',
    hostKind: 'personal',
    credentialFree: true,
  })
}

/**
 * What a signed-in owner client does for a host it manages (ADR 0001 "Registration apart
 * from link"): an enrollment ticket with its own account token, handed to the host over
 * the trusted local connection (`uplinkRegister`). Answers the host's status.
 */
export async function registerHost(stack: LocalCloudStack, host: HostAddress, owner: SignedIn): Promise<UplinkStatus> {
  const accountToken = await owner.oauth.accessToken({ kind: 'account' })
  if (!accountToken) throw new Error(`${owner.persona.name} got no account token`)
  const response = await fetch(`${stack.origin}/v1/enrollment-tickets`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accountToken}`, 'content-type': 'application/json', accept: 'application/json', connection: 'close' },
    body: '{}',
  })
  if (!response.ok) throw new Error(`The enrollment ticket answered ${response.status}: ${await response.text()}`)
  const ticket = enrollmentTicketResponseSchema.parse(await response.json())
  const local = localOwnerClient(host, owner.persona)
  const dialed = await local.connect()
  if (!dialed.ok) throw new Error(`The local owner could not connect: ${JSON.stringify(dialed)}`)
  try {
    return await local.rpc('uplinkRegister', { ticket: ticket.ticket, directoryUrl: stack.origin })
  } finally {
    local.close()
  }
}

/**
 * A client that dials the host with the person's access token for the host's audience,
 * through the ticket door (`/auth/ws-ticket`), as a remote client does. The door makes
 * the person's delegation: `personal` for the owner (and the organization an owner
 * names), else the organization named.
 */
export function hostClient(host: HostAddress, signedIn: SignedIn, hostId: string, options: { asOwner: boolean; organizationId?: string; organizationRole?: 'owner' | 'member' }): LabClient {
  const persona = signedIn.persona
  return new LabClient({
    persona: options.asOwner
      ? { id: persona.name.toLowerCase(), kind: 'host-owner', userId: persona.userId, displayName: persona.name }
      : { id: persona.name.toLowerCase(), kind: 'org-member', userId: persona.userId, displayName: persona.name, organizationId: options.organizationId ?? persona.organizationId, organizationRole: options.organizationRole ?? persona.organizationRole, teamIds: [] },
    hostUrl: host.tunnelUrl,
    hostId,
    hostKind: 'personal',
    // An owner who names an organization works in it: the door makes that delegation too.
    organizationId: options.asOwner ? options.organizationId : undefined,
    accessToken: () => signedIn.oauth.accessToken({ kind: 'host', hostId }),
  })
}

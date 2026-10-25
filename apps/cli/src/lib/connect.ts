import { spawn } from 'child_process'
import {
  requestDeviceCode,
  waitForDeviceApproval,
  type DeviceCodeGrant,
} from '@solus/client-core/device-authorization'
import { OAuthSession, type StoredGrant } from '@solus/client-core/oauth-session'
import { SOLUS_CLIENT_IDS } from '@solus/contracts/auth/clients'
import {
  accountResponseSchema,
  enrollmentTicketResponseSchema,
  parseLinkCode,
  uplinkStatusSchema,
  type AccountOrganization,
  type EnrollmentTicketRequest,
  type HostRegistrationRequest,
  type UplinkStatus,
} from '@solus/contracts/uplink'
import { hostOrganizationsStatusSchema, type HostOrganizationsStatus } from '@solus/contracts/organization-scope'
import { installCloudflared } from './cloudflared'
import { requireRunningServerUrl, withLocalRpc } from './local-rpc'
import { runtimePaths, windowsSystemTool } from './runtime'

export const CLI_DEVICE_CLIENT_ID = SOLUS_CLIENT_IDS.cli
export const DEFAULT_CLOUD_ORIGIN = 'https://app.solus.sh'

/**
 * How this server connects to Solus (plans/009-organization-vms.md §5;
 * docs/adr/0001-standard-authentication.md §2.2 rules 8 and 9). The code registers the
 * server to the account, and then `connect` links it, so it is reachable from the
 * internet through a Cloudflare tunnel: a server set up from a shell is usually on
 * another network. A link code carries its ticket and the account plane that issued
 * it, so one string is enough: an organization's "Add your own VM" code attaches the
 * server to that organization; a personal code registers it to the account. Without a
 * code, the person signs in on another device and chooses.
 */
export interface ConnectOptions {
  dataDir: string
  /** The account plane to sign in to when no code names one. */
  cloudUrl?: string
  noOpen: boolean
  /** A link code a signed-in client or the account website issued. */
  code?: string
}

/** What the person decides after signing in, when no code decided it. */
export type ConnectChoice =
  | { kind: 'personal' }
  | { kind: 'organization'; organizationId: string }

export interface ConnectReporter {
  deviceCode(grant: DeviceCodeGrant): void
  stage(message: string): void
  /** After sign-in, when no code decided: a personal link, or an organization among the account's. */
  choose(organizations: AccountOrganization[], current: UplinkStatus): Promise<ConnectChoice>
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

/** The server's own registration, link, and organization calls, over the trusted loopback socket. */
interface LocalHostApi {
  uplinkStatus(): Promise<UplinkStatus>
  uplinkRegister(request: HostRegistrationRequest): Promise<UplinkStatus>
  uplinkLink(): Promise<UplinkStatus>
  uplinkUnlink(): Promise<UplinkStatus>
  uplinkDetachOrganization(organizationId: string): Promise<UplinkStatus>
  hostOrganizations(): Promise<HostOrganizationsStatus>
}

async function withLocalHost<T>(dataDir: string, run: (api: LocalHostApi) => Promise<T>): Promise<T> {
  return withLocalRpc(requireRunningServerUrl(runtimePaths(dataDir)), (call) => run({
    uplinkStatus: async () => uplinkStatusSchema.parse(await call('uplinkStatus')),
    uplinkRegister: async (request) => uplinkStatusSchema.parse(await call('uplinkRegister', [request])),
    uplinkLink: async () => uplinkStatusSchema.parse(await call('uplinkLink')),
    uplinkUnlink: async () => uplinkStatusSchema.parse(await call('uplinkUnlink')),
    uplinkDetachOrganization: async (organizationId) => uplinkStatusSchema.parse(await call('uplinkDetachOrganization', [organizationId])),
    hostOrganizations: async () => hostOrganizationsStatusSchema.parse(await call('hostOrganizations')),
  }))
}

/**
 * Registers this server (or attaches it to an organization when it is registered
 * already), then links it. A code needs nothing else. Without one, the person signs in
 * with the device flow — whose URL and code they open on any device, so this works
 * over SSH — and then chooses personal or one of their organizations.
 */
export async function connectHost(options: ConnectOptions, reporter: ConnectReporter): Promise<UplinkStatus> {
  const current = await withLocalHost(options.dataDir, (api) => api.uplinkStatus())
  reporter.stage('Checking cloudflared')
  await installCloudflared({ dataDir: options.dataDir })
  reporter.stage('cloudflared is ready')

  if (options.code) {
    const request = parseLinkCode(options.code, resolveCloudOrigin(options.cloudUrl))
    return withLocalHost(options.dataDir, (api) => registerAndLink(api, request))
  }
  const cloudOrigin = current.registration.registered ? current.registration.registration.directoryUrl : resolveCloudOrigin(options.cloudUrl)
  const session = await authorizeCli(cloudOrigin, options.noOpen, reporter)
  try {
    const choice = await reporter.choose(await accountOrganizations(cloudOrigin, await accountToken(session)), current)
    if (choice.kind === 'personal' && current.registration.registered) return withLocalHost(options.dataDir, (api) => current.link.linked ? Promise.resolve(current) : api.uplinkLink())
    const organizationIds = choice.kind === 'organization' ? [choice.organizationId] : []
    const ticket = await issueEnrollmentTicket(cloudOrigin, await accountToken(session), organizationIds.length ? { organizationIds } : {})
    return await withLocalHost(options.dataDir, (api) => registerAndLink(api, { ticket, directoryUrl: cloudOrigin, organizationIds }))
  } finally {
    // The setup client keeps no copy: sign-out revokes its client grant (RFC 7009).
    await session.signOut()
  }
}

/** Registers (or attaches) with the ticket, then turns the tunnel on when it is not on. */
async function registerAndLink(api: LocalHostApi, request: HostRegistrationRequest): Promise<UplinkStatus> {
  const registered = await api.uplinkRegister(request)
  return registered.link.linked ? registered : api.uplinkLink()
}

export async function connectStatus(dataDir: string): Promise<{ uplink: UplinkStatus; standing: HostOrganizationsStatus }> {
  return withLocalHost(dataDir, async (api) => ({ uplink: await api.uplinkStatus(), standing: await api.hostOrganizations() }))
}

/**
 * Unlinks this server: the tunnel goes, and the internet no longer reaches it. Its
 * registration and organizations stay; removing the host on the account's Devices
 * page ends them.
 */
export async function disconnectHost(dataDir: string): Promise<UplinkStatus> {
  return withLocalHost(dataDir, async (api) => {
    const current = await api.uplinkStatus()
    return current.link.linked ? api.uplinkUnlink() : current
  })
}

/** Takes this server's attachment back for one organization; the registration and its other organizations stay. */
export async function removeOrganization(dataDir: string, organizationId: string): Promise<HostOrganizationsStatus> {
  return withLocalHost(dataDir, async (api) => {
    await api.uplinkDetachOrganization(organizationId)
    return api.hostOrganizations()
  })
}

/**
 * Signs the CLI in with the device grant (RFC 8628) and holds the OAuth tokens in
 * memory for this one command: the CLI keeps no sign-in between commands.
 */
export async function authorizeCli(
  cloudOrigin: string,
  noOpen: boolean,
  reporter: Pick<ConnectReporter, 'deviceCode' | 'stage'>,
  fetchImpl: typeof fetch = fetch,
  sleepImpl: (ms: number, signal: AbortSignal) => Promise<void> = sleep,
): Promise<OAuthSession> {
  const grant = await requestDeviceCode({
    cloudOrigin,
    clientId: CLI_DEVICE_CLIENT_ID,
    fetch: fetchImpl,
    now: Date.now,
  })
  reporter.deviceCode(grant)
  if (!noOpen && !process.env.SSH_CONNECTION && !process.env.SSH_TTY) openBrowser(grant.verificationUrl)
  const result = await waitForDeviceApproval(
    grant,
    { cloudOrigin, fetch: fetchImpl, now: Date.now, sleep: sleepImpl },
    new AbortController().signal,
  )
  if (result.end !== 'approved') throw new Error(result.message)
  let held: StoredGrant | null = null
  const session = new OAuthSession({
    cloudOrigin,
    clientId: CLI_DEVICE_CLIENT_ID,
    store: { load: () => held, save: (next) => { held = next }, clear: () => { held = null } },
    fetch: fetchImpl,
    now: Date.now,
  })
  if (await session.adoptTokens(result.tokens) !== 'approved') throw new Error('Solus Cloud answered with tokens this CLI could not use.')
  reporter.stage('Account approved')
  return session
}

/** An access token for the account plane, for `/v1`. */
async function accountToken(session: OAuthSession): Promise<string> {
  const token = await session.accessToken({ kind: 'account' })
  if (!token) throw new Error('Solus Cloud did not give an access token for your account.')
  return token
}

async function accountOrganizations(cloudOrigin: string, accessToken: string): Promise<AccountOrganization[]> {
  const response = await fetch(`${cloudOrigin}/v1/account`, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    redirect: 'error',
  })
  if (!response.ok) throw new Error(`Solus Cloud could not read your organizations (${response.status})`)
  return accountResponseSchema.parse(await response.json()).organizations
}

async function issueEnrollmentTicket(cloudOrigin: string, accessToken: string, body: EnrollmentTicketRequest): Promise<string> {
  const response = await fetch(`${cloudOrigin}/v1/enrollment-tickets`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'error',
  })
  if (response.status === 403) throw new Error('Your account is not a member of that organization.')
  if (!response.ok) throw new Error(`Solus Cloud could not issue a link code (${response.status})`)
  const parsed = enrollmentTicketResponseSchema.safeParse(await response.json().catch(() => null))
  if (!parsed.success) throw new Error('Solus Cloud returned an invalid link code')
  return parsed.data.ticket
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

/**
 * The program that opens a web page. On Windows the server's opener uses
 * `cmd /c start`, but cmd reads `&` in a URL as a new command, so the CLI uses
 * `rundll32 url.dll,FileProtocolHandler`, which takes the URL as one argument.
 * That handler opens any path, so only an http(s) URL is passed to it.
 */
export function browserOpenCommand(url: string, platform: NodeJS.Platform): [string, string[]] | null {
  if (!/^https?:\/\//i.test(url)) return null
  if (platform === 'darwin') return ['open', [url]]
  if (platform === 'win32') return [windowsSystemTool('rundll32.exe'), ['url.dll,FileProtocolHandler', url]]
  return ['xdg-open', [url]]
}

function openBrowser(url: string): void {
  const opener = browserOpenCommand(url, process.platform)
  if (!opener) return
  const child = spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' })
  child.once('error', () => {})
  child.unref()
}

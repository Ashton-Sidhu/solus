import { spawn } from 'child_process'
import {
  requestDeviceCode,
  waitForDeviceApproval,
  type DeviceCodeGrant,
} from '@solus/client-core/device-authorization'
import {
  accountResponseSchema,
  enrollmentTicketResponseSchema,
  parseLinkCode,
  uplinkStatusSchema,
  type AccountOrganization,
  type EnrollmentTicketRequest,
  type UplinkLinkRequest,
  type UplinkStatus,
} from '@solus/contracts/uplink'
import { hostOrganizationsStatusSchema, type HostOrganizationsStatus } from '@solus/contracts/organization-scope'
import { installCloudflared } from './cloudflared'
import { requireRunningServerUrl, withLocalRpc } from './local-rpc'
import { runtimePaths } from './runtime'

export const CLI_DEVICE_CLIENT_ID = 'solus-cli'
export const DEFAULT_CLOUD_ORIGIN = 'https://app.solus.sh'

/**
 * How this server links to Solus (plans/009-organization-vms.md §5). A link code
 * carries its ticket and the account plane that issued it, so one string is
 * enough: an organization's "Add your own VM" code attaches the server to that
 * organization; a personal code links it for discovery and remote access. Without
 * a code, the person signs in on another device and chooses.
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

/** The server's own link and organization calls, over the trusted loopback socket. */
interface LocalHostApi {
  uplinkStatus(): Promise<UplinkStatus>
  uplinkLink(request: UplinkLinkRequest): Promise<UplinkStatus>
  uplinkUnlink(): Promise<UplinkStatus>
  uplinkDetachOrganization(organizationId: string): Promise<UplinkStatus>
  hostOrganizations(): Promise<HostOrganizationsStatus>
}

async function withLocalHost<T>(dataDir: string, run: (api: LocalHostApi) => Promise<T>): Promise<T> {
  return withLocalRpc(requireRunningServerUrl(runtimePaths(dataDir)), (call) => run({
    uplinkStatus: async () => uplinkStatusSchema.parse(await call('uplinkStatus')),
    uplinkLink: async (request) => uplinkStatusSchema.parse(await call('uplinkLink', [request])),
    uplinkUnlink: async () => uplinkStatusSchema.parse(await call('uplinkUnlink')),
    uplinkDetachOrganization: async (organizationId) => uplinkStatusSchema.parse(await call('uplinkDetachOrganization', [organizationId])),
    hostOrganizations: async () => hostOrganizationsStatusSchema.parse(await call('hostOrganizations')),
  }))
}

/**
 * Links this server, or attaches it to an organization when it is already linked.
 * A code needs nothing else. Without one, the person signs in with the device flow
 * — whose URL and code they open on any device, so this works over SSH — and then
 * chooses a personal link or one of their organizations.
 */
export async function connectHost(options: ConnectOptions, reporter: ConnectReporter): Promise<UplinkStatus> {
  const current = await withLocalHost(options.dataDir, (api) => api.uplinkStatus())
  reporter.stage('Checking cloudflared')
  await installCloudflared({ dataDir: options.dataDir })
  reporter.stage('cloudflared is ready')

  if (options.code) {
    const request = parseLinkCode(options.code, resolveCloudOrigin(options.cloudUrl))
    return withLocalHost(options.dataDir, (api) => api.uplinkLink(request))
  }
  const cloudOrigin = current.linked ? current.link.directoryUrl : resolveCloudOrigin(options.cloudUrl)
  const sessionToken = await authorizeCli(cloudOrigin, options.noOpen, reporter)
  try {
    const choice = await reporter.choose(await accountOrganizations(cloudOrigin, sessionToken), current)
    if (choice.kind === 'personal' && current.linked) return current
    const ticket = await issueEnrollmentTicket(cloudOrigin, sessionToken, choice.kind === 'organization' ? { organizationIds: [choice.organizationId] } : {})
    return await withLocalHost(options.dataDir, (api) => api.uplinkLink({ ticket, directoryUrl: cloudOrigin }))
  } finally {
    await signOutCloudSession(cloudOrigin, sessionToken)
  }
}

export async function connectStatus(dataDir: string): Promise<{ link: UplinkStatus; standing: HostOrganizationsStatus }> {
  return withLocalHost(dataDir, async (api) => ({ link: await api.uplinkStatus(), standing: await api.hostOrganizations() }))
}

/** Unlinks this server; an attached server becomes personal again, and its organizations' records stay on the Solus API. */
export async function disconnectHost(dataDir: string): Promise<UplinkStatus> {
  return withLocalHost(dataDir, async (api) => {
    const current = await api.uplinkStatus()
    return current.linked ? api.uplinkUnlink() : current
  })
}

/** Takes this server's attachment back for one organization; the link and its other organizations stay. */
export async function removeOrganization(dataDir: string, organizationId: string): Promise<HostOrganizationsStatus> {
  return withLocalHost(dataDir, async (api) => {
    await api.uplinkDetachOrganization(organizationId)
    return api.hostOrganizations()
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

async function accountOrganizations(cloudOrigin: string, sessionToken: string): Promise<AccountOrganization[]> {
  const response = await fetch(`${cloudOrigin}/v1/account`, {
    headers: { authorization: `Bearer ${sessionToken}`, accept: 'application/json' },
    redirect: 'error',
  })
  if (!response.ok) throw new Error(`Solus Cloud could not read your organizations (${response.status})`)
  return accountResponseSchema.parse(await response.json()).organizations
}

async function issueEnrollmentTicket(cloudOrigin: string, sessionToken: string, body: EnrollmentTicketRequest): Promise<string> {
  const response = await fetch(`${cloudOrigin}/v1/enrollment-tickets`, {
    method: 'POST',
    headers: { authorization: `Bearer ${sessionToken}`, accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'error',
  })
  if (response.status === 403) throw new Error('Your account is not a member of that organization.')
  if (!response.ok) throw new Error(`Solus Cloud could not issue a link code (${response.status})`)
  const parsed = enrollmentTicketResponseSchema.safeParse(await response.json().catch(() => null))
  if (!parsed.success) throw new Error('Solus Cloud returned an invalid link code')
  return parsed.data.ticket
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

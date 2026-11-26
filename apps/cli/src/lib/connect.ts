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
  isOrganizationTicket,
  parseLinkCode,
  uplinkStatusSchema,
  type AccountOrganization,
  type EnrollmentTicketRequest,
  type HostRegistrationRequest,
  type UplinkStatus,
} from '@solus/contracts/uplink'
import { hostOrganizationsStatusSchema, type HostOrganizationsStatus } from '@solus/contracts/organization-scope'
import { hostSelfTestSchema, type HostSelfTest } from '@solus/contracts/host-connection'
import { readCloudMachineRecord, readLinkReach, type LinkReach } from './cloud-machine'
import { installCloudflared } from './cloudflared'
import { requireRunningServerUrl, withLocalRpc } from './local-rpc'
import { runtimePaths, windowsSystemTool } from './runtime'

export const CLI_DEVICE_CLIENT_ID = SOLUS_CLIENT_IDS.cli
export const DEFAULT_CLOUD_ORIGIN = 'https://app.solus.sh'

/**
 * How this server connects to Solus (plans/034-one-cloud-machine-kind.md;
 * docs/adr/0001-standard-authentication.md §2.2 rules 8 and 9). A link code carries its
 * ticket and the account plane that issued it, so one string is enough. Without a
 * code, the person signs in on another device and chooses.
 *
 * - The code decides what the server is. A personal code (`set_…`) registers it to the
 *   person's account. An organization code (`org_…`), or an organization choice,
 *   makes it a cloud machine of that one organization.
 * - The address decides how the internet reaches it, for both kinds. With `--address`
 *   the server is reached at that HTTPS address, and there is no tunnel. Without it
 *   the server gets a Cloudflare tunnel, which needs `cloudflared`.
 * - A cloud machine enrolls and links inside the one `uplinkRegister` call, and after
 *   that call it refuses its local socket.
 */
export interface ConnectOptions {
  dataDir: string
  /** The account plane to sign in to when no code names one. */
  cloudUrl?: string
  noOpen: boolean
  /** A link code a signed-in client or the account website issued. */
  code?: string
  /** This machine's own HTTPS address (`parseMachineAddress`): the internet reaches the server there, with no tunnel. */
  address?: string
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

export interface ConnectSelfTest {
  selfTest: HostSelfTest | null
  selfTestError: string | null
}

/** The server's own registration, link, and organization calls, over the trusted loopback socket. */
export interface LocalHostApi {
  uplinkStatus(): Promise<UplinkStatus>
  uplinkRegister(request: HostRegistrationRequest): Promise<UplinkStatus>
  uplinkLink(address?: string): Promise<UplinkStatus>
  uplinkUnlink(): Promise<UplinkStatus>
  hostOrganizations(): Promise<HostOrganizationsStatus>
  hostSelfTest(): Promise<HostSelfTest>
}

async function withLocalHost<T>(dataDir: string, run: (api: LocalHostApi) => Promise<T>): Promise<T> {
  return withLocalRpc(requireRunningServerUrl(runtimePaths(dataDir)), (call) => run({
    uplinkStatus: async () => uplinkStatusSchema.parse(await call('uplinkStatus')),
    uplinkRegister: async (request) => uplinkStatusSchema.parse(await call('uplinkRegister', [request])),
    uplinkLink: async (address) => uplinkStatusSchema.parse(await call('uplinkLink', address ? [address] : [])),
    uplinkUnlink: async () => uplinkStatusSchema.parse(await call('uplinkUnlink')),
    hostOrganizations: async () => hostOrganizationsStatusSchema.parse(await call('hostOrganizations')),
    hostSelfTest: async () => hostSelfTestSchema.parse(await call('hostSelfTest')),
  }))
}

/** What `connectHost` reaches outside this process; a test gives its own. */
export interface ConnectDeps {
  localHost<T>(dataDir: string, run: (api: LocalHostApi) => Promise<T>): Promise<T>
  installCloudflared(dataDir: string): Promise<void>
  fetch: typeof fetch
  sleep(ms: number, signal: AbortSignal): Promise<void>
}

const systemConnectDeps: ConnectDeps = {
  localHost: withLocalHost,
  installCloudflared: async (dataDir) => { await installCloudflared({ dataDir }) },
  fetch,
  sleep,
}

/** A cloud machine admits no local connection, so the command line changes nothing on it. */
const CLOUD_MACHINE_IS_FIXED = 'This server is a cloud host of an organization already. An organization owner removes the machine in the Solus console. To set up another machine, use a new data directory (`--data-dir PATH`).'

const REGISTERED_ALREADY = 'This server is registered to a Solus account already, so it cannot become a cloud host of an organization. A cloud host starts with new data: set it up with a new data directory (`--data-dir PATH`).'

/**
 * Connects this server to Solus. A code needs nothing else. Without one, the person
 * signs in with the device flow — whose URL and code they open on any device, so this
 * works over SSH — and then chooses personal or one of their organizations.
 *
 * An address goes to the server with the ticket, and no cloudflared is installed for
 * it. A server that is registered already keeps what it is: an organization code or
 * choice is refused, and an address changes only how the internet reaches it.
 */
export async function connectHost(options: ConnectOptions, reporter: ConnectReporter, deps: ConnectDeps = systemConnectDeps): Promise<UplinkStatus> {
  if (readCloudMachineRecord(options.dataDir)) throw new Error(CLOUD_MACHINE_IS_FIXED)
  const { address } = options
  const current = await deps.localHost(options.dataDir, (api) => api.uplinkStatus())
  const isRegistered = current.registration.registered
  const request = options.code ? parseLinkCode(options.code, resolveCloudOrigin(options.cloudUrl)) : null
  if (request && isOrganizationTicket(request.ticket) && isRegistered) throw new Error(REGISTERED_ALREADY)
  // The registration of the server asks for the new reach itself: no ticket, and no sign-in.
  if (address && isRegistered) return deps.localHost(options.dataDir, (api) => api.uplinkLink(address))
  /** A tunnel needs cloudflared; a server that is reached at its own address needs nothing. */
  const prepareReach = async (): Promise<void> => {
    if (address) return
    reporter.stage('Checking cloudflared')
    await deps.installCloudflared(options.dataDir)
    reporter.stage('cloudflared is ready')
  }

  if (request) {
    if (address) request.address = address
    await prepareReach()
    return deps.localHost(options.dataDir, (api) => isOrganizationTicket(request.ticket) ? api.uplinkRegister(request) : registerAndLink(api, request))
  }
  const cloudOrigin = current.registration.registered ? current.registration.registration.directoryUrl : resolveCloudOrigin(options.cloudUrl)
  const session = await authorizeCli(cloudOrigin, options.noOpen, reporter, deps.fetch, deps.sleep)
  try {
    const choice = await reporter.choose(await accountOrganizations(cloudOrigin, await accountToken(session), deps.fetch), current)
    if (choice.kind === 'organization' && isRegistered) throw new Error(REGISTERED_ALREADY)
    await prepareReach()
    if (current.registration.registered) return await deps.localHost(options.dataDir, (api) => current.link.linked ? Promise.resolve(current) : api.uplinkLink())
    const ticket = await issueEnrollmentTicket(cloudOrigin, await accountToken(session), choice.kind === 'organization' ? { organizationId: choice.organizationId } : {}, deps.fetch)
    const issued: HostRegistrationRequest = { ticket, directoryUrl: cloudOrigin }
    if (address) issued.address = address
    return await deps.localHost(options.dataDir, (api) => choice.kind === 'organization' ? api.uplinkRegister(issued) : registerAndLink(api, issued))
  } finally {
    // The setup client keeps no copy: sign-out revokes its client grant (RFC 7009).
    await session.signOut()
  }
}

/**
 * A personal join: the server registers with the ticket and links a new registration
 * in that call. The link is turned on here when that link did not finish. A cloud
 * machine gets no second call: it refuses the local socket after `uplinkRegister`,
 * and asks for its link again by itself.
 */
async function registerAndLink(api: LocalHostApi, request: HostRegistrationRequest): Promise<UplinkStatus> {
  const registered = await api.uplinkRegister(request)
  return registered.link.linked ? registered : api.uplinkLink()
}

/** What a personal server says about its connection, and the reach that its link record names. */
export interface ConnectionStatus {
  uplink: UplinkStatus
  standing: HostOrganizationsStatus
  reach: LinkReach
}

/** The live connection of a personal server. A cloud machine has none for the command line (`readCloudMachineRecord`). */
export async function connectStatus(dataDir: string): Promise<ConnectionStatus> {
  return withLocalHost(dataDir, async (api) => ({ uplink: await api.uplinkStatus(), standing: await api.hostOrganizations(), reach: readLinkReach(dataDir) }))
}

/** What `solus connect status` adds: the server tests its own connection. An older server has no such test. */
export async function connectSelfTest(dataDir: string): Promise<ConnectSelfTest> {
  try {
    return { selfTest: await withLocalHost(dataDir, (api) => api.hostSelfTest()), selfTestError: null }
  } catch (error) {
    return { selfTest: null, selfTestError: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Unlinks this personal server: the tunnel goes, Solus cloud forgets its address, and
 * the internet no longer reaches it. Its registration stays; removing the host on the
 * account's Devices page ends it. A cloud machine has no link to turn off here: its
 * organization owns it.
 */
export async function disconnectHost(dataDir: string): Promise<UplinkStatus> {
  if (readCloudMachineRecord(dataDir)) throw new Error('A cloud host is not unlinked from the command line. An organization owner removes the machine in the Solus console.')
  return withLocalHost(dataDir, async (api) => {
    const current = await api.uplinkStatus()
    return current.link.linked ? api.uplinkUnlink() : current
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

async function accountOrganizations(cloudOrigin: string, accessToken: string, fetchImpl: typeof fetch): Promise<AccountOrganization[]> {
  const response = await fetchImpl(`${cloudOrigin}/v1/account`, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    redirect: 'error',
  })
  if (!response.ok) throw new Error(`Solus Cloud could not read your organizations (${response.status})`)
  return accountResponseSchema.parse(await response.json()).organizations
}

async function issueEnrollmentTicket(cloudOrigin: string, accessToken: string, body: EnrollmentTicketRequest, fetchImpl: typeof fetch): Promise<string> {
  const response = await fetchImpl(`${cloudOrigin}/v1/enrollment-tickets`, {
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

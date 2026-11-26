import { enforce, hostPolicies, hostPolicyStore } from '../../host/policy/host-policy-store'
import { accountConnectionsUrl } from '../../vault/account-reads'
import { ownerKeyOf } from '../../admission/actor'
import { credentialLocationOf } from '../../vault/vault'
import { permissionsFor } from '../../admission/access-policy'
import { wirePrincipalKind } from '../../admission/principal'
import { generatePairToken, listPairedDevices, revokeDevice, getInstallationId } from '../../admission/auth'
import { appAccessChecks, appApproverOf, approvedRedirect, createAppPairingCode, type AppApprover } from '../../admission/app-sign-in'
import { readAppSignInRequest, settleAppSignInRequest } from '../../admission/app-sign-in-requests'
import { createTokenBucketRateLimiter } from '../rate-limit'
import { advertisedRoutes, discoverTailnetServers, listReachableEndpoints } from '../endpoints'
import { appAddressesOf, probeAppAddress } from '../app-addresses'
import { hostIdentity } from '../../host/host-identity'
import { shareRoutesFor } from '../../sharing/share-routes'
import { shareResourceSchema, type ShareResource } from '@solus/contracts/sharing'
import { createLogger } from '../../logger'
import { captureServerEvent } from '../../analytics'
import { hostIdentityKeySchema } from '@solus/contracts/host-identity'
import type { DiscoveredServer } from '@solus/contracts/types'
import type { ConnectionsServerInfo, RemoteAccessMode, TailscaleServeStatus } from '@solus/contracts/host-api'
import type { HandlerCtx, SolusServer } from '../server'
import { hostUserKey } from '../../host/host-user'
import { memberUsers } from '../../host/member-users'
import { recentEventLoopStall } from '../../host/event-loop-stalls'
import { isCloudMachine } from '../../host/cloud-machine'
import { sshTarget } from '../../host/ssh-target'
import type { IntroducedHosts } from '../../execution/orchestration/introduced-hosts'
import { z } from 'zod'

const log = createLogger('main', 'connections-handlers')

export interface ConnectionsDeps {
  /** Returns the bound host/port — these change on each launch when port==0. */
  getServerInfo(): Pick<ConnectionsServerInfo, 'host' | 'port' | 'allowLan' | 'remoteAccess' | 'requireAuth' | 'trustLocalNetwork' | 'hostKind' | 'roles'>
  /** Returns currently-connected WebSocket clients. */
  getActiveSessions(): ActiveConnectionSession[]
  discoverLanServers(): Promise<DiscoveredServer[]>
  setRemoteAccess(remoteAccess: RemoteAccessMode): Promise<{ remoteAccess: RemoteAccessMode; host: string; port: number; allowLan: boolean; requireAuth: boolean }>
  getTailscaleServe(): Promise<TailscaleServeStatus>
  enableTailscaleServe(port: number): Promise<TailscaleServeStatus>
  disableTailscaleServe(): Promise<TailscaleServeStatus>
  /** Tailscale Funnel on or off for the mapping Serve made to this host (plans/035 §0.8). */
  setTailscaleFunnel(enabled: boolean): Promise<TailscaleServeStatus>
  /** The host setting `publicAddress`: the https origin of the person's own ingress, or empty. */
  publicAddress(): string
  setTrustLocalNetwork(trustLocalNetwork: boolean): { trustLocalNetwork: boolean }
  /** The hosts this host was introduced to (docs/plans/host-reach.md §4). */
  introducedHosts: Pick<IntroducedHosts, 'list' | 'issue' | 'accept' | 'forget' | 'allow'>
  /** Closes an open connection to a host whose introduction was replaced or forgotten. */
  disconnectRemoteHost(hostId: string): void
  /** A new introduction: this host introduces the machines it holds to each other (host-reach.md §4.4). */
  onIntroduced?(): void
  /** This host's tunnel origin while its connector is online; null otherwise. */
  tunnelUrl(): string | null
  /** The account origin when the resource is mirrored there (a published session of an organization on a linked host); null otherwise. */
  mirrorOrigin(resource: ShareResource): Promise<string | null>
}

export interface ActiveConnectionSession {
  id: string
  deviceLabel: string
  deviceId: string | null
  /** The device is a host acting for a person; a revoke records it as a host, not an account grant. */
  isActingHost: boolean
  connectedAt: number
}

export interface AggregatedConnectionSession extends Omit<ActiveConnectionSession, 'isActingHost'> {
  connectionCount: number
  connectionIds: string[]
}

export function aggregateConnectionSessionsByDevice(sessions: ActiveConnectionSession[]): AggregatedConnectionSession[] {
  const grouped = new Map<string, AggregatedConnectionSession>()

  for (const session of sessions) {
    const key = session.deviceId ? `device:${session.deviceId}` : `connection:${session.id}`
    const existing = grouped.get(key)
    if (!existing) {
      grouped.set(key, {
        id: session.deviceId ? key : session.id,
        deviceLabel: session.deviceLabel,
        deviceId: session.deviceId,
        connectedAt: session.connectedAt,
        connectionCount: 1,
        connectionIds: [session.id],
      })
      continue
    }

    existing.connectionCount += 1
    existing.connectionIds.push(session.id)
    existing.connectedAt = Math.min(existing.connectedAt, session.connectedAt)
  }

  return [...grouped.values()].sort((a, b) => a.connectedAt - b.connectedAt)
}

export function registerConnectionsHandlers(server: SolusServer, deps: ConnectionsDeps): void {
  void isCloudMachine()
  server.register('connectionsGetServerInfo', async (_args, ctx) => {
    const info = deps.getServerInfo()
    const principal = ctx.principal
    // What this connection may do here, so every control disables exactly when the gate would refuse (permissions.md).
    const routes = await advertisedRoutes(info.host, info.port)
    const answer: ConnectionsServerInfo = {
      ...info,
      installationId: getInstallationId(),
      routes,
      cloudWithoutTailnet: await isCloudMachine() && !routes.some((route) => route.kind === 'tailnet'),
      tailscaleServe: await deps.getTailscaleServe(),
      sshTarget: await sshTarget(),
      identityKey: hostIdentity().publicKey(),
      principal: wirePrincipalKind(principal),
      permissions: permissionsFor(principal),
      policy: loadedPolicy(),
    }
    const connectionsUrl = credentialLocationOf(ownerKeyOf(ctx.actor)).kind === 'account' ? accountConnectionsUrl() : null
    if (connectionsUrl) answer.accountConnectionsUrl = connectionsUrl
    // The one person the client is on this host: "is this me?" compares against it (plans/012 §1).
    if (ctx.actor.user) answer.user = ctx.actor.user
    if (principal.kind === 'owner') {
      // The person at the machine is the host's user (plans/012 §1), through every door
      // (plans/031 D1): the reader knows its key as their own.
      answer.userId = hostUserKey()
    }
    if (principal.kind === 'org-member') {
      answer.userId = principal.userId
      answer.organizationId = principal.organizationId
      answer.displayName = principal.displayName
      // The host object has not made their Linux user yet (docs/plans/member-isolation.md §8.1).
      const users = memberUsers()
      if (users && !users.userOf(principal.userId)) answer.memberWorkspace = 'preparing'
    }
    if (principal.kind === 'guest') {
      // The one thing a guest client needs to know at boot: what it was let in to see.
      answer.displayName = principal.displayName
      answer.userId = principal.accountUserId
      answer.share = { resource: principal.share.resource, role: principal.share.role }
      if (principal.share.actions) answer.share.actions = principal.share.actions
    }
    // A client that just came back after a drop learns if this host froze (docs/mobile-connections.md).
    const stall = recentEventLoopStall()
    if (stall) answer.recentEventLoopStall = stall
    return answer
  })

  server.register('connectionsListEndpoints', async () => {
    const { host, port } = deps.getServerInfo()
    return await listReachableEndpoints(host, port)
  })

  // docs/plans/host-sharing.md §2: a mirrored session's link names the account origin,
  // which hands the guest to this host when it answers and to the mirror when it does
  // not; everything else is reached on this host alone.
  server.register('shareLinkOrigin', async (args) => {
    const resource = shareResourceSchema.parse(args[0])
    const mirror = await deps.mirrorOrigin(resource)
    if (mirror) return { origin: mirror }
    const { host, port } = deps.getServerInfo()
    return { origin: shareRoutesFor(deps.tunnelUrl(), await listReachableEndpoints(host, port))[0]?.url ?? null }
  })
  server.register('discoverServers', async () => {
    const { port } = deps.getServerInfo()
    const [lan, tailnet] = await Promise.all([
      deps.discoverLanServers(),
      discoverTailnetServers({ boundPort: port, ownInstallationId: getInstallationId() }),
    ])
    const discovered = new Map<string, DiscoveredServer>()
    for (const candidate of [...tailnet, ...lan]) {
      if (!discovered.has(candidate.installationId)) discovered.set(candidate.installationId, candidate)
    }
    return [...discovered.values()]
  })

  server.register('connectionsGeneratePairToken', () => {
    enforce(hostPolicies().capabilityDenial('remoteAccess', 'pairing devices'))
    const t = generatePairToken()
    log.info('pair_token_generated', { expiresInMinutes: 5 })
    captureServerEvent('pair_token_generated', {})
    return t
  })

  server.register('connectionsListSessions', () => {
    return aggregateConnectionSessionsByDevice(deps.getActiveSessions())
  })

  server.register('connectionsListDevices', () => listPairedDevices())

  const appAddresses = async () => appAddressesOf({ tunnel: deps.tunnelUrl(), serve: await deps.getTailscaleServe(), publicAddress: deps.publicAddress() })

  server.register('connectionsAppEndpoint', async () => {
    const addresses = await appAddresses()
    return {
      localUrl: `http://localhost:${deps.getServerInfo().port}/mcp`,
      publicUrl: addresses.find((address) => address.reach === 'internet')?.url ?? null,
      addresses,
    }
  })

  // The caller names only a source: the host asks the address it lists for it, never a URL from the wire (no SSRF).
  server.register('connectionsTestAppAddress', async (args) => {
    const { source } = testAddressSchema.parse(args[0])
    const address = (await appAddresses()).find((candidate) => candidate.source === source)
    if (!address) return { reachable: false, reason: 'This host has no address from that source now.' }
    const result = await probeAppAddress(address, { installationId: getInstallationId() })
    log.info('app_address_tested', { source, reachable: result.reachable })
    return result
  })

  server.register('connectionsCreateAppPairingCode', (args, ctx) => {
    const [{ access }] = args
    // The app the code approves acts as the person who made it.
    const approver = appApproverOf(ctx.principal)
    if (!approver) throw new Error('Only the host owner or a member of its organization can connect an outside app.')
    const code = createAppPairingCode(approver, access)
    log.info('app_pairing_code_created', { expiresAt: code.expiresAt, approver: approver.kind, access })
    return code
  })

  server.register('connectionsReadAppSignIn', (args, ctx) => {
    const approver = signInApprover(ctx)
    const by = readSignInSchema.parse(args[0])
    // A check code is short: each person tries a few a minute. An id is too long to guess.
    if ('checkCode' in by && !checkCodeReads.allow(approver.kind === 'member' ? `member:${approver.userId}` : 'owner')) throw new Error('Too many tries. Wait a minute.')
    const found = readAppSignInRequest(by)
    if (!found) throw new Error(NO_SIGN_IN)
    return found.view
  })

  server.register('connectionsDecideAppSignIn', (args, ctx) => {
    const approver = signInApprover(ctx)
    const { requestId, decision } = decideSignInSchema.parse(args[0])
    const found = readAppSignInRequest({ requestId })
    if (!found) throw new Error(NO_SIGN_IN)
    const { signIn } = found
    if (decision === 'approve') {
      // The person's organization may allow only some apps (plans/035 §10).
      const denied = appAccessChecks().appDenial(signIn.app, approver)
      if (denied) throw new Error(denied)
    }
    // Nothing awaits between the read and here, so the sign-in still waits.
    settleAppSignInRequest(requestId, decision === 'approve' ? { approve: approvedRedirect(signIn, approver) } : 'deny')
    const facts = { decision, app: signIn.app, access: signIn.access, approver: approver.kind }
    if (approver.kind === 'member') log.info('app_sign_in_decided', { ...facts, userId: approver.userId, organizationId: approver.organizationId })
    else log.info('app_sign_in_decided', facts)
    return { ok: true as const }
  })

  server.register('connectionsRevokeDevice', (args) => {
    const [{ deviceId }] = args
    const isActingHost = deps.getActiveSessions().some((session) => session.deviceId === deviceId && session.isActingHost)
    revokeDevice(deviceId, isActingHost ? 'host' : 'grant')
    return { ok: true }
  })

  server.register('connectionsSetRemoteAccess', async (args) => {
    const [{ remoteAccess }] = args
    return deps.setRemoteAccess(remoteAccess === 'off' || remoteAccess === 'private' ? remoteAccess : 'any')
  })

  server.register('connectionsGetTailscaleServe', () => deps.getTailscaleServe())
  server.register('connectionsEnableTailscaleServe', (args) => deps.enableTailscaleServe(args[0].port))
  server.register('connectionsDisableTailscaleServe', () => deps.disableTailscaleServe())
  server.register('connectionsSetTailscaleFunnel', (args) => deps.setTailscaleFunnel(z.object({ enabled: z.boolean() }).parse(args[0]).enabled))

  server.register('connectionsSetTrustLocalNetwork', (args) => {
    const [{ trustLocalNetwork }] = args
    return deps.setTrustLocalNetwork(trustLocalNetwork === true)
  })

  server.register('hostIntroductionsList', () => deps.introducedHosts.list())

  server.register('hostIntroductionIssue', (args) => {
    enforce(hostPolicies().capabilityDenial('remoteAccess', 'host introductions'))
    const [forHost] = args
    return deps.introducedHosts.issue(forHostSchema.parse(forHost))
  })

  server.register('hostIntroductionAccept', async (args) => {
    enforce(hostPolicies().capabilityDenial('remoteAccess', 'host introductions'))
    const [{ introduction, grantedDeviceId }] = args
    const parsed = introductionSchema.parse(introduction)
    await deps.introducedHosts.accept(parsed, z.string().min(1).parse(grantedDeviceId))
    deps.disconnectRemoteHost(parsed.installationId)
    deps.onIntroduced?.()
    return { ok: true as const }
  })

  server.register('hostIntroductionForget', (args) => {
    const [{ installationId }] = args
    const forgotten = deps.introducedHosts.forget(installationId)
    deps.disconnectRemoteHost(installationId)
    return { forgotten }
  })

  server.register('hostIntroductionAllow', (args) => {
    const [{ installationId }] = args
    return { allowed: deps.introducedHosts.allow(installationId) }
  })
}

const testAddressSchema = z.object({ source: z.enum(['solus', 'tailscale-funnel', 'tailscale-serve', 'custom']) }).strict()
const readSignInSchema = z.union([z.object({ requestId: z.string().min(1).max(128) }).strict(), z.object({ checkCode: z.string().min(1).max(16) }).strict()])
const decideSignInSchema = z.object({ requestId: z.string().min(1).max(128), decision: z.enum(['approve', 'deny']) }).strict()
/** Unknown, expired, and decided read the same, so a check code tells nothing about other sign-ins. */
const NO_SIGN_IN = 'This sign-in does not wait for approval. Start it again in the app.'
const checkCodeReads = createTokenBucketRateLimiter(10, 60_000)

/**
 * The person who decides an outside app's sign-in in their own client: the app
 * acts as them. The rule of making a pairing code (`appApproverOf`), and never a
 * host acting for a person, which is an agent, not the person at a client.
 */
function signInApprover(ctx: HandlerCtx): AppApprover {
  const approver = ctx.actingHostId ? null : appApproverOf(ctx.principal)
  if (!approver) throw new Error('Only the host owner or a member of its organization can approve an outside app, from their own Solus client.')
  return approver
}

const forHostSchema = z.object({ installationId: z.string().min(1), label: z.string().max(128) })
const introductionSchema = z.object({
  installationId: z.string().min(1),
  label: z.string().max(128),
  urls: z.array(z.string().min(1)).max(16),
  sessionToken: z.string().min(1),
  deviceId: z.string().min(1),
  identityKey: hostIdentityKeySchema,
})

/** What policies this host enforces now: the MDM policy it read at start, and the cloud documents it holds. */
function loadedPolicy(): NonNullable<ConnectionsServerInfo['policy']> {
  const mdm = hostPolicyStore().mdm()
  const cloud: NonNullable<ConnectionsServerInfo['policy']>['cloud'] = []
  for (const [organizationId, entry] of Object.entries(hostPolicies().set.organizations)) {
    if (entry.state !== 'ready') continue
    cloud.push({ organizationId, kind: 'organization', revision: entry.policy.document.revision ?? null })
    if (entry.hostPolicy) cloud.push({ organizationId, kind: 'host', revision: entry.hostPolicy.document.revision ?? null })
  }
  return { mdmSource: mdm?.source ?? null, mdmFingerprint: mdm?.fingerprint ?? null, cloud }
}

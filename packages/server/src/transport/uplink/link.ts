import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import type { HostOperatingSystem } from '@solus/contracts/types'
import {
  enrollHostResponseSchema,
  hostAttachResponseSchema,
  hostCredentialResponseSchema,
  hostLinkResponseSchema,
  tokenEndpoint,
  uplinkDesiredStateSchema,
  uplinkErrorBodySchema,
  uplinkLinkConfigSchema,
  hostClientId,
  type EnrollHostRequest,
  type HostAttachRequest,
  type HostCredentialRequest,
  type HostLinkEnv,
  type UplinkLinkConfig,
  type UplinkLinkRequest,
  type UplinkLinkState,
  type UplinkObservedState,
  type UplinkStatus,
} from '@solus/contracts/uplink'
import { createLogger } from '../../logger'
import { dataDir, solusDir } from '../../platform/paths'
import { secretStore } from '../../platform/secrets'
import type { FetchLike } from '../../admission/access-tokens'
import type { ConnectorObservation } from './connector'
import { hostCategory } from '../../host/host-category'
import {
  HostCredentialError,
  clientCredential,
  forgetHostKey,
  generateHostKey,
  loadHostKey,
  publicJwkOf,
  saveHostKey,
  type HostCredential,
  type PrivateJwk,
} from '../../host/host-credential'

const log = createLogger('main', 'uplink-link')

/**
 * The host's side of the cloud link (docs/plans/personal-uplink.md, H2 and H4).
 *
 * Durable state is the non-secret link record with the *desired* state in
 * `SOLUS_DATA_DIR/uplink-link.json`, and two secrets: the tunnel's connector token,
 * and the host credential, the private half of the key this host made for the link
 * (`host/host-credential.ts`, docs/adr/0001-standard-authentication.md §3.4). Every
 * transition writes desired state first and then acts, so a crash between the two
 * resumes correctly at boot: an unlink that did not reach the control plane is retried,
 * a link that is desired starts its connector after the generation check.
 */

const LINK_FILE = 'uplink-link.json'
const TOKENS_KEY = 'uplink-tokens'
const REQUEST_TIMEOUT_MS = 10_000

const persistedLinkSchema = z.object({
  version: z.literal(1),
  desired: uplinkDesiredStateSchema,
  link: uplinkLinkConfigSchema,
  /**
   * When the owner attached this server for organization work (organization-vms §4):
   * from then on new root work needs an organization and new personal roots are
   * refused. Written before the host admits any organization work, kept across
   * restarts, and gone with the link, so an unlink resets the server to personal.
   */
  attachedAt: z.number().int().nonnegative().optional(),
}).strict()
/** The tunnel's connector token: infrastructure, not identity. Absent for a directly reached link (a managed host). */
const tokensSchema = z.object({
  connectorToken: z.string().min(1).optional(),
})

type PersistedLink = z.infer<typeof persistedLinkSchema>
type UplinkTokens = z.infer<typeof tokensSchema>

export interface UplinkConnectorHandle {
  start(token: string): void
  stop(): Promise<void>
}

export interface UplinkLinkDeps {
  installationId: () => string
  hostLabel: () => string
  os: () => HostOperatingSystem | undefined
  /** The loopback port the proxied listener is bound to; 0 when it failed to bind. */
  proxiedPort: () => number
  connector: UplinkConnectorHandle
  /** The current link, or null once unlinked — the grant verifier follows it. */
  onLinkChanged?: (link: UplinkLinkConfig | null) => void
  /** What `status()` now answers, after every link, unlink, or connector observation — the clients' `host.uplinkStatusChanged`. */
  onStatusChanged?: (status: UplinkStatus) => void
  fetchImpl?: FetchLike
  /** A provisioned machine (managed-hosts.md §2): the link the control plane put in the environment; null on a machine a person links. */
  provisionedLink?: () => HostLinkEnv | null
}

export class UplinkLinkError extends Error {
  constructor(readonly code: 'not-linked' | 'enroll-rejected' | 'attach-rejected' | 'control-plane-unreachable', message: string) {
    super(message)
    this.name = 'UplinkLinkError'
  }
}

export class UplinkLinkManager {
  private persisted: PersistedLink | null
  private observed: UplinkObservedState = 'offline'
  private observedError: string | undefined
  /** Solus cloud no longer accepts the stored link: another copy took it, it was removed, or its credentials are gone. */
  private linkRejected = false
  /** The credential of the stored key, kept so its control token is reused until it nears its end. */
  private heldCredential: { key: string; credential: HostCredential } | null = null

  constructor(private readonly deps: UplinkLinkDeps) {
    this.persisted = readPersistedLink()
  }

  currentLink(): UplinkLinkConfig | null {
    return this.persisted?.desired === 'linked' ? this.persisted.link : null
  }

  /**
   * The host credential of the current link: its own control token for the link
   * routes, and the client assertion with which it acts for people (`Delegations`).
   * Null when unlinked, or when the key is gone.
   */
  credential(): HostCredential | null {
    return this.credentialOf(this.currentLink())
  }

  /** The credential for a link record, desired or being unlinked; null when the kept key is not this link's. */
  private credentialOf(link: UplinkLinkConfig | null): HostCredential | null {
    const key = link ? loadHostKey() : null
    if (!link || !key || key.generation !== link.connectionGeneration) return null
    const cacheKey = `${key.clientId}\u0000${key.generation}\u0000${key.privateJwk.x}`
    if (this.heldCredential?.key !== cacheKey) {
      const options: Parameters<typeof clientCredential>[0] = { clientId: key.clientId, privateJwk: key.privateJwk, tokenEndpoint: tokenEndpoint(link.directoryUrl) }
      if (this.deps.fetchImpl) options.fetchImpl = this.deps.fetchImpl
      this.heldCredential = { key: cacheKey, credential: clientCredential(options) }
    }
    return this.heldCredential.credential
  }

  /** When the owner attached this server for organization work; null while it is personal or unlinked. */
  attachedAt(): number | null {
    return this.persisted?.desired === 'linked' ? this.persisted.attachedAt ?? null : null
  }

  /**
   * Records the attachment the first time the host learns of it — an enrollment or
   * attach that named organizations, a standing that lists a shared organization, or a
   * member admitted for organization work — before any organization work is admitted.
   * A person's own computer is never attached (organization-vms §1).
   */
  markAttached(): number | null {
    if (!this.persisted || this.persisted.desired !== 'linked' || hostCategory() === 'personal') return null
    if (this.persisted.attachedAt !== undefined) return this.persisted.attachedAt
    const attachedAt = Date.now()
    this.setPersisted({ ...this.persisted, attachedAt })
    log.info('uplink_organization_attached', { hostId: this.persisted.link.hostId })
    return attachedAt
  }

  status(): UplinkStatus {
    if (!this.persisted || this.persisted.desired !== 'linked') return { linked: false }
    // A link Solus cloud rejected is no link: nothing can be delivered or reached through it,
    // and Link replaces it. The reason stays visible.
    if (this.linkRejected) return { linked: false, error: this.observedError ?? SUPERSEDED_MESSAGE }
    const state: UplinkLinkState = this.observedError
      ? { observed: this.observed, error: this.observedError }
      : { observed: this.observed }
    return { linked: true, link: this.persisted.link, state }
  }

  /**
   * Enroll with the control plane and start the connector. A host that is already
   * linked redeems the ticket as an organization attachment instead: the same code
   * a person copies links a new host or attaches one already linked.
   */
  async link(request: UplinkLinkRequest): Promise<UplinkStatus> {
    // A link Solus cloud rejected cannot attach anything: its token is dead. Link anew.
    if (this.persisted?.desired === 'linked' && this.linkRejected) this.forgetRejectedLink()
    if (this.persisted?.desired === 'linked') return this.attach(request)
    if (this.persisted) {
      // An unlink the control plane has not confirmed yet: finish it first so the old
      // link is not orphaned there under a token nobody holds any more.
      await this.completeUnlink()
      if (this.persisted) throw new UplinkLinkError('control-plane-unreachable', 'The previous link is still being removed. Try again in a moment.')
    }
    if (!this.deps.proxiedPort()) {
      throw new UplinkLinkError('enroll-rejected', 'The tunnel listener is not running on this host; restart Solus and try again.')
    }
    const directoryUrl = normalizeOrigin(request.directoryUrl)
    const category = hostCategory()
    // Each link has a new key: linking again rotates it, and the old one proves nothing.
    const key = await generateHostKey()
    const body: EnrollHostRequest = {
      ticket: request.ticket,
      installationId: this.deps.installationId(),
      label: this.deps.hostLabel(),
      os: this.deps.os(),
      proxiedPort: this.deps.proxiedPort(),
      // What this process is, declared once at enrolment; the control plane records it (organization-scope §3.1).
      ...(category === 'managed' ? {} : { category }),
      publicJwk: key.publicJwk,
    }
    const response = await this.request(`${directoryUrl}/v1/hosts/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      const detail = uplinkErrorBodySchema.safeParse(await response.json().catch(() => ({})))
      throw new UplinkLinkError('enroll-rejected', enrollRejectionMessage(response.status, detail.data?.error, detail.data?.message))
    }
    const enrolled = enrollHostResponseSchema.parse(await response.json())
    return this.storeLink({
      link: enrolled.link,
      connectorToken: enrolled.connectorToken,
      key: { clientId: enrolled.oauthClient.clientId, privateJwk: key.privateJwk },
      attached: !!enrolled.organizationIds?.length,
    }, 'uplink_linked')
  }

  /**
   * Redeems an organization-bound ticket for a host already linked (organization-vms
   * §4): the control plane checks the owner's membership again and records the
   * attachment; the host persists it before it admits organization work. The code
   * must come from the account plane this host is linked to.
   */
  private async attach(request: UplinkLinkRequest): Promise<UplinkStatus> {
    const persisted = this.persisted
    if (!persisted) throw new UplinkLinkError('not-linked', 'This host is not linked.')
    if (normalizeOrigin(request.directoryUrl) !== normalizeOrigin(persisted.link.directoryUrl)) {
      throw new UplinkLinkError('attach-rejected', `This host is linked to ${persisted.link.directoryUrl}. Use a code from there, or unlink first.`)
    }
    const body: HostAttachRequest = { ticket: request.ticket }
    const response = await this.request(`${persisted.link.directoryUrl}/v1/hosts/${persisted.link.hostId}/organizations/attach`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await this.controlToken()}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      const detail = uplinkErrorBodySchema.safeParse(await response.json().catch(() => ({})))
      throw new UplinkLinkError('attach-rejected', attachRejectionMessage(response.status, detail.data?.error))
    }
    const attached = hostAttachResponseSchema.parse(await response.json())
    this.markAttached()
    log.info('uplink_attach_redeemed', { hostId: persisted.link.hostId, organizations: attached.organizationIds.length })
    this.deps.onLinkChanged?.(this.currentLink())
    return this.status()
  }

  /** Takes this host's organization attachment back for one organization; the link, its records, and its other organizations stay. */
  async detach(organizationId: string): Promise<UplinkStatus> {
    const persisted = this.persisted
    if (!persisted || persisted.desired !== 'linked') throw new UplinkLinkError('not-linked', 'This host is not linked.')
    const response = await this.request(`${persisted.link.directoryUrl}/v1/hosts/${persisted.link.hostId}/organizations/${encodeURIComponent(organizationId)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${await this.controlToken()}` },
    })
    if (response.status !== 204) throw new UplinkLinkError('attach-rejected', `Solus cloud refused to remove the organization (${response.status}).`)
    log.info('uplink_organization_detached', { hostId: persisted.link.hostId, organizationId })
    this.deps.onLinkChanged?.(this.currentLink())
    return this.status()
  }

  /** The host's own control token for its link routes; a refused key reads as a link Solus cloud no longer accepts. */
  private async controlToken(): Promise<string> {
    const credential = this.credential()
    if (!credential) throw new UplinkLinkError('not-linked', 'This host has no key for its link. Link it again.')
    try {
      return await credential.hostAccessToken()
    } catch (error) {
      if (error instanceof HostCredentialError && error.code === 'refused') {
        this.markSuperseded()
        throw new UplinkLinkError('not-linked', SUPERSEDED_MESSAGE)
      }
      throw new UplinkLinkError('control-plane-unreachable', error instanceof Error ? error.message : String(error))
    }
  }

  /** What every link ends with: the secrets to the secret store, the record to disk, the connector up. */
  private storeLink(
    input: { link: UplinkLinkConfig; connectorToken: string | undefined; key: { clientId: string; privateJwk: PrivateJwk }; attached: boolean },
    event: 'uplink_linked' | 'provisioned_link_adopted',
  ): UplinkStatus {
    const { link, connectorToken } = input
    // The host will trust this issuer's keys, call this directory with its own
    // token, and deliver organization records to this API: only a private-network
    // origin may be plain http.
    for (const url of [link.issuer, link.jwksUrl, link.directoryUrl, ...(link.apiUrl ? [link.apiUrl] : [])]) {
      if (!isSecureOrigin(url)) throw new UplinkLinkError('enroll-rejected', `Solus cloud named an insecure address (${url}); the link was not made.`)
    }
    secretStore().saveJson(TOKENS_KEY, tokensElectronPath(), { connectorToken })
    saveHostKey({ clientId: input.key.clientId, generation: link.connectionGeneration, privateJwk: input.key.privateJwk })
    // An enrollment that attached organizations is persisted as attached in the same write (organization-vms §4).
    const persisted: PersistedLink = { version: 1, desired: 'linked', link }
    if (input.attached && hostCategory() === 'self-hosted') persisted.attachedAt = Date.now()
    this.linkRejected = false
    this.setPersisted(persisted)
    this.setObservation({ observed: 'offline' })
    this.startReach(connectorToken)
    log.info(event, { hostId: link.hostId, hostname: link.hostname, generation: link.connectionGeneration })
    return this.status()
  }

  /**
   * A provisioned host's first boot of a link (managed-hosts.md §2, ADR 0001 §3.4): it
   * makes its key, keeps it, and registers the public half with the one-time ticket the
   * link carries. A boot that runs again before the answer came sends the same key, which
   * the control plane accepts. Only then is the link stored.
   */
  private async adoptProvisionedLink(env: HostLinkEnv): Promise<void> {
    const { link } = env
    const clientId = hostClientId(link.hostId)
    const kept = loadHostKey()
    const privateJwk = kept && kept.generation === link.connectionGeneration && kept.clientId === clientId ? kept.privateJwk : (await generateHostKey()).privateJwk
    saveHostKey({ clientId, generation: link.connectionGeneration, privateJwk })
    const body: HostCredentialRequest = { credentialTicket: env.credentialTicket, publicJwk: publicJwkOf(privateJwk) }
    const response = await this.request(`${normalizeOrigin(link.directoryUrl)}/v1/hosts/${link.hostId}/credential`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      log.warn('provisioned_credential_refused', { hostId: link.hostId, status: response.status })
      throw new UplinkLinkError('enroll-rejected', `Solus cloud refused this machine's key (${response.status}).`)
    }
    const registered = hostCredentialResponseSchema.parse(await response.json())
    this.storeLink({ link, connectorToken: undefined, key: { clientId: registered.oauthClient.clientId, privateJwk }, attached: false }, 'provisioned_link_adopted')
  }

  /** Drop a link Solus cloud already rejected; there is nothing to tell it. */
  private forgetRejectedLink(): void {
    void this.deps.connector.stop()
    secretStore().remove(TOKENS_KEY, tokensElectronPath())
    forgetHostKey()
    this.linkRejected = false
    this.setPersisted(null)
    log.info('uplink_rejected_link_forgotten')
  }

  /** Desired state first, then the connector, then the control plane, then the secrets. */
  async unlink(): Promise<UplinkStatus> {
    if (!this.persisted) throw new UplinkLinkError('not-linked', 'This host is not linked.')
    this.setPersisted({ ...this.persisted, desired: 'unlinked' })
    await this.deps.connector.stop()
    await this.completeUnlink()
    return this.status()
  }

  /** Boot: finish an interrupted unlink, or verify the generation and start the connector. */
  async resume(): Promise<void> {
    try {
      await this.resumeLink()
    } catch (err) {
      log.warn('uplink_resume_failed', { error: err instanceof Error ? err.message : String(err) })
      this.setObservation({ observed: 'error', error: 'The tunnel could not start. Restart Solus to try again.' })
    }
  }

  private async resumeLink(): Promise<void> {
    // A provisioned host stores the link its environment carries (managed-hosts.md §2):
    // at first boot, and again whenever the control plane hands it a newer generation
    // (a recreated machine). A record at the same or a later generation wins; the
    // environment is then the stale copy.
    const envLink = this.deps.provisionedLink?.()
    if (envLink && (!this.persisted || envLink.link.connectionGeneration > this.persisted.link.connectionGeneration)) {
      await this.adoptProvisionedLink(envLink)
      return
    }
    if (!this.persisted) return
    if (this.persisted.desired === 'unlinked') {
      await this.completeUnlink()
      return
    }
    const tokens = this.loadTokens()
    if (!tokens || !this.credential()) {
      // The record says linked but the credentials are gone: the host cannot run the
      // tunnel or prove itself. Surface it; the owner re-links.
      this.setObservation({ observed: 'error', error: 'Link credentials are missing; link this host again.' })
      this.linkRejected = true
      return
    }
    const { proxiedPort } = this.persisted.link
    if (this.deps.proxiedPort() !== proxiedPort) {
      // The tunnel's ingress points at a port this host could not bind. Running the
      // connector would only make every request 502; say so instead.
      this.setObservation({ observed: 'error', error: `Port ${proxiedPort} is in use on this host, so the tunnel cannot reach it. Free the port and restart Solus, or unlink and link again.` })
      return
    }
    const verdict = await this.checkGeneration()
    if (verdict === 'current') this.startReach(tokens.connectorToken)
    else if (verdict === 'unknown') {
      this.setObservation({ observed: 'error', error: 'Solus cloud could not verify this link. Restart Solus to try again.' })
    }
  }

  /**
   * The tunnel's connector when the link has one. Without one the host is reached
   * directly — its platform proxy forwards to the proxied listener — so there is
   * nothing to run and nothing to observe: a current link is online.
   */
  private startReach(connectorToken: string | undefined): void {
    if (connectorToken) this.deps.connector.start(connectorToken)
    else this.setObservation({ observed: 'online' })
  }

  handleConnectorObservation(observation: ConnectorObservation): void {
    // A superseded host keeps its verdict; the connector's last gasp must not overwrite it.
    if (this.observedError === SUPERSEDED_MESSAGE) return
    this.setObservation(observation)
  }

  private async completeUnlink(): Promise<void> {
    const persisted = this.persisted
    if (!persisted) return
    const credential = this.credentialOf(persisted.link)
    if (credential) {
      let done = false
      try {
        // A refused key means the control plane no longer knows this host's client: the
        // unlink already happened, or a newer link superseded this copy. Done here.
        const token = await credential.hostAccessToken().catch(refusedAsNull)
        if (token) {
          const response = await this.request(`${persisted.link.directoryUrl}/v1/hosts/${persisted.link.hostId}/link`, {
            method: 'DELETE',
            headers: { authorization: `Bearer ${token}` },
          })
          // 401 is the same answer for a control token: the link is no longer this copy's.
          done = response.status === 204 || response.status === 401 || response.status === 404
          if (!done) log.warn('uplink_unlink_rejected', { status: response.status })
        } else {
          done = true
        }
      } catch (err) {
        log.warn('uplink_unlink_deferred', { error: err instanceof Error ? err.message : String(err) })
      }
      if (!done) return
    }
    secretStore().remove(TOKENS_KEY, tokensElectronPath())
    forgetHostKey()
    this.setPersisted(null)
    this.setObservation({ observed: 'offline' })
    log.info('uplink_unlinked', { hostId: persisted.link.hostId })
  }

  /** H4: only the current link's key and control token are accepted; a restored copy learns it was superseded here. */
  private async checkGeneration(): Promise<'current' | 'superseded' | 'unknown'> {
    const link = this.currentLink()
    const credential = this.credential()
    if (!link || !credential) return 'unknown'
    try {
      const token = await credential.hostAccessToken()
      const response = await this.request(`${link.directoryUrl}/v1/hosts/${link.hostId}/link`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      })
      if (response.status === 401 || response.status === 404) return this.markSuperseded()
      if (!response.ok) return 'unknown'
      const record = hostLinkResponseSchema.parse(await response.json())
      if (record.connectionGeneration > link.connectionGeneration || record.desired !== 'linked') {
        return this.markSuperseded()
      }
      return 'current'
    } catch (err) {
      if (err instanceof HostCredentialError && err.code === 'refused') return this.markSuperseded()
      log.warn('uplink_generation_check_failed', { error: err instanceof Error ? err.message : String(err) })
      return 'unknown'
    }
  }

  private markSuperseded(): 'superseded' {
    log.warn('uplink_superseded', { hostId: this.persisted?.link.hostId ?? null })
    this.setObservation({ observed: 'error', error: SUPERSEDED_MESSAGE })
    this.linkRejected = true
    return 'superseded'
  }

  private request(url: string, init: RequestInit): Promise<Response> {
    const fetchImpl: FetchLike = this.deps.fetchImpl ?? fetch
    return fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }).catch((err) => {
      throw new UplinkLinkError('control-plane-unreachable', `Solus cloud is not reachable: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  private loadTokens(): UplinkTokens | null {
    return secretStore().loadJson(TOKENS_KEY, tokensElectronPath(), tokensSchema)
  }

  private setPersisted(next: PersistedLink | null): void {
    this.persisted = next
    writePersistedLink(next)
    this.deps.onLinkChanged?.(this.currentLink())
    this.deps.onStatusChanged?.(this.status())
  }

  private setObservation(observation: ConnectorObservation): void {
    this.observed = observation.observed
    this.observedError = observation.observed === 'error' ? observation.error : undefined
    this.deps.onStatusChanged?.(this.status())
  }
}

/** A key the account plane refused reads as no token: the link is no longer this copy's. Anything else is an outage. */
function refusedAsNull(error: Error): null {
  if (error instanceof HostCredentialError && error.code === 'refused') return null
  throw error
}

export const SUPERSEDED_MESSAGE = 'Another copy of this host holds the link; link this host again to take it over.'

function attachRejectionMessage(status: number, code: string | undefined): string {
  switch (code) {
    case 'invalid_ticket': return 'The code is invalid, has expired, or was not made by this host\'s owner for an organization. Get a new code from Organization settings → Add your own VM.'
    case 'not_a_member': return 'The account that made the code is no longer a member of that organization.'
    case 'personal_hosts_not_allowed': return 'That organization does not allow personal computers.'
    default: return `Solus cloud refused to attach this host (${status}).`
  }
}

/** The link stored on disk, read before the manager exists: what the boot needs to know about this machine before it listens. */
export function readStoredLink(): UplinkLinkConfig | null {
  const persisted = readPersistedLink()
  return persisted?.desired === 'linked' ? persisted.link : null
}

function enrollRejectionMessage(status: number, code: string | undefined, message: string | undefined): string {
  switch (code) {
    case 'invalid_ticket': return 'The link ticket is invalid or has expired. Start linking again.'
    case 'tunnel_not_configured': return 'Solus cloud is not set up for tunnels yet.'
    case 'tunnel_account_limit': return 'Solus cloud cannot allocate another tunnel right now.'
    case 'tunnel_provisioning_failed': return `Solus cloud could not set up the tunnel${message ? `: ${message}` : ''}.`
    default: return `Solus cloud refused the link (${status}).`
  }
}

function normalizeOrigin(directoryUrl: string): string {
  return new URL(directoryUrl).origin
}

/** `https:`, or `http:` to loopback for development against a local control plane. */
export function isSecureOrigin(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'https:') return true
    return parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]')
  } catch {
    return false
  }
}

function linkFile(): string {
  return join(solusDir(), LINK_FILE)
}

function tokensElectronPath(): string {
  return join(dataDir(), 'uplink-tokens.bin')
}

function readPersistedLink(): PersistedLink | null {
  const file = linkFile()
  if (!existsSync(file)) return null
  try {
    const parsed = persistedLinkSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
    return parsed.success ? parsed.data : null
  } catch (err) {
    log.warn('uplink_link_file_unreadable', { error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

function writePersistedLink(value: PersistedLink | null): void {
  const file = linkFile()
  if (!value) {
    if (existsSync(file)) unlinkSync(file)
    return
  }
  const dir = solusDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 })
}

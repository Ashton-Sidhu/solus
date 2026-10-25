import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import type { HostOperatingSystem } from '@solus/contracts/types'
import {
  enrollHostResponseSchema,
  hostAttachResponseSchema,
  hostClientId,
  hostCredentialResponseSchema,
  hostLinkResponseSchema,
  hostRegistrationSchema,
  tokenEndpoint,
  uplinkErrorBodySchema,
  type EnrollHostRequest,
  type HostAttachRequest,
  type HostCredentialRequest,
  type HostLinkEnv,
  type HostLinkResponse,
  type HostOwnerIdentity,
  type HostRegistration,
  type HostRegistrationRequest,
  type HostRegistrationStatus,
} from '@solus/contracts/uplink'
import type { FetchLike } from '../admission/access-tokens'
import { createLogger } from '../logger'
import { solusDir } from '../platform/paths'
import { hostCategory } from './host-category'
import {
  HostCredentialError,
  forgetHostKey,
  clientCredential,
  generateHostKey,
  loadHostKey,
  publicJwkOf,
  saveHostKey,
  type HostCredential,
  type PrivateJwk,
} from './host-credential'

const log = createLogger('main', 'host-registration')

/**
 * The host's identity at the account plane (docs/adr/0001-standard-authentication.md
 * §2.2 rule 8). A host registers with its owner's account the first time a signed-in
 * owner client gives it a ticket: the desktop on sign-in, any signed-in owner client
 * for a standalone host. The registration is the record in
 * `SOLUS_DATA_DIR/host-registration.json` and the host's key in the secret store
 * (`host-credential.ts`). Identity, delegations, account reads, organizations, and the
 * directory need it, and nothing else; the link (`transport/uplink/link.ts`) only
 * exposes a registered host to the internet (rule 9).
 */

const REGISTRATION_FILE = 'host-registration.json'
const REQUEST_TIMEOUT_MS = 10_000
/** A boot check Solus cloud did not answer is asked again after this, then after twice the wait each time. */
const RESUME_RETRY_FIRST_MS = 30_000
/** The longest wait between two boot checks: Solus cloud is never asked more often than this once the waits have grown. */
const RESUME_RETRY_MAX_MS = 10 * 60_000

const persistedRegistrationSchema = z.object({
  version: z.literal(1),
  registration: hostRegistrationSchema,
  /**
   * When the owner attached this server for organization work (organization-vms §4):
   * from then on new root work needs an organization and new personal roots are
   * refused. Written before the host admits any organization work, kept across
   * restarts, and gone with the registration, so a deleted host is personal again.
   */
  attachedAt: z.number().int().nonnegative().optional(),
}).strict()
type PersistedRegistration = z.infer<typeof persistedRegistrationSchema>

export interface HostRegistrarDeps {
  installationId: () => string
  hostLabel: () => string
  os: () => HostOperatingSystem | undefined
  /** The account the control plane says this host is registered to; null before it answered. */
  owner: () => HostOwnerIdentity | null
  /** The registration was made, changed, or ended. */
  onRegistrationChanged?: (registration: HostRegistration | null) => void
  /** What `status()` answers changed. */
  onStatusChanged?: () => void
  /** A provisioned machine (managed-hosts.md §2): the registration the control plane put in the environment; null on a machine a person registers. */
  provisionedLink?: () => HostLinkEnv | null
  fetchImpl?: FetchLike
  /** Runs `run` after `delayMs` and answers how to cancel it; a test drives the boot retries with its own. */
  schedule?: (run: () => Promise<void>, delayMs: number) => () => void
}

/** What one boot check found: Solus cloud's answer, and whether it could not be asked, so the check is tried again. */
interface ResumeAttempt {
  remote: HostLinkResponse | null
  isUnanswered: boolean
}

/** A real timer that does not keep the process alive. */
function scheduleTimer(run: () => Promise<void>, delayMs: number): () => void {
  const timer = setTimeout(() => { void run() }, delayMs)
  timer.unref?.()
  return () => clearTimeout(timer)
}

export class HostRegistrationError extends Error {
  constructor(readonly code: 'not-registered' | 'register-rejected' | 'attach-rejected' | 'control-plane-unreachable', message: string) {
    super(message)
    this.name = 'HostRegistrationError'
  }
}


export class HostRegistrar {
  private persisted: PersistedRegistration | null
  private heldCredential: { key: string; credential: HostCredential } | null = null
  private registering: Promise<HostRegistrationStatus> | null = null
  /** Cancels the boot check that waits to be tried again; null while none waits. */
  private cancelResumeRetry: (() => void) | null = null
  private isResumeStopped = false

  constructor(private readonly deps: HostRegistrarDeps) {
    this.persisted = readPersistedRegistration()
  }

  /** The registration this host proves itself with; null while it is not registered. */
  current(): HostRegistration | null {
    return this.persisted?.registration ?? null
  }

  /**
   * Whether a signed-in owner client should register this host now (rule 8): it holds
   * no usable key. A registration that Solus cloud refuses is forgotten (`forget`), so the
   * host is simply not registered, and this one rule applies to it again.
   */
  needsRegistration(): boolean {
    return !this.credential()
  }

  /**
   * The host credential: its own control token for its host routes, and the client
   * assertion with which it acts for people (`Delegations`). Null while unregistered, or
   * when the key is gone.
   */
  credential(): HostCredential | null {
    const registration = this.current()
    const key = registration ? loadHostKey() : null
    if (!registration || !key || key.generation !== registration.generation) return null
    const cacheKey = `${key.clientId}\u0000${key.generation}\u0000${key.privateJwk.x}`
    if (this.heldCredential?.key !== cacheKey) {
      const options: Parameters<typeof clientCredential>[0] = { clientId: key.clientId, privateJwk: key.privateJwk, tokenEndpoint: tokenEndpoint(registration.directoryUrl) }
      if (this.deps.fetchImpl) options.fetchImpl = this.deps.fetchImpl
      this.heldCredential = { key: cacheKey, credential: clientCredential(options) }
    }
    return this.heldCredential.credential
  }

  /** The host's control token. */
  async controlToken(): Promise<string> {
    const credential = this.credential()
    if (!credential) throw new HostRegistrationError('not-registered', 'This host is not registered to a Solus account.')
    try {
      return await credential.hostAccessToken()
    } catch (error) {
      if (error instanceof HostCredentialError && error.code === 'refused') {
        this.forget()
        throw new HostRegistrationError('not-registered', 'Solus cloud no longer accepts this host’s registration.')
      }
      throw new HostRegistrationError('control-plane-unreachable', error instanceof Error ? error.message : String(error))
    }
  }

  /** When the owner attached this server for organization work; null while it is personal or unregistered. */
  attachedAt(): number | null {
    return this.persisted?.attachedAt ?? null
  }

  /**
   * Records the attachment the first time the host learns of it — a registration or
   * attach that named organizations, a standing that lists a shared organization, or a
   * member admitted for organization work — before any organization work is admitted.
   * A person's own computer is never attached (organization-vms §1).
   */
  markAttached(): number | null {
    if (!this.persisted || hostCategory() === 'personal') return null
    if (this.persisted.attachedAt !== undefined) return this.persisted.attachedAt
    const attachedAt = Date.now()
    this.setPersisted({ ...this.persisted, attachedAt })
    log.info('host_organization_attached', { hostId: this.persisted.registration.hostId })
    return attachedAt
  }

  status(): HostRegistrationStatus {
    if (!this.persisted) return { registered: false }
    return { registered: true, registration: this.persisted.registration, owner: this.deps.owner() }
  }

  /**
   * Registers this host with a ticket its owner's client got with its own account
   * token (rule 8). No tunnel is made. A host registered already redeems a ticket that
   * names organizations as an attachment (organization-vms §4), and ignores one that
   * names none: two clients that both saw an unregistered host register it once.
   */
  register(request: HostRegistrationRequest): Promise<HostRegistrationStatus> {
    const run = (this.registering ?? Promise.resolve(this.status()))
      .catch(() => this.status())
      .then(() => this.registerNow(request))
    this.registering = run
    return run.finally(() => { if (this.registering === run) this.registering = null })
  }

  private async registerNow(request: HostRegistrationRequest): Promise<HostRegistrationStatus> {
    if (this.persisted && this.credential()) {
      if (!request.organizationIds?.length) return this.status()
      return this.attach(request)
    }
    const directoryUrl = normalizeOrigin(request.directoryUrl)
    const category = hostCategory()
    // Each registration has a new key: registering again rotates it, and the old one proves nothing.
    const key = await generateHostKey()
    const body: EnrollHostRequest = {
      ticket: request.ticket,
      installationId: this.deps.installationId(),
      label: this.deps.hostLabel(),
      os: this.deps.os(),
      // What this process is, declared once at registration; the control plane records it (organization-scope §3.1).
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
      throw new HostRegistrationError('register-rejected', registerRejectionMessage(response.status, detail.data?.error))
    }
    const enrolled = enrollHostResponseSchema.parse(await response.json())
    this.store({
      registration: enrolled.registration,
      key: { clientId: enrolled.oauthClient.clientId, privateJwk: key.privateJwk },
      attached: !!enrolled.organizationIds?.length,
    }, 'host_registered')
    return this.status()
  }

  /**
   * Redeems an organization-bound ticket for a host registered already
   * (organization-vms §4): the control plane checks the owner's membership again and
   * records the attachment; the host persists it before it admits organization work.
   * The code must come from the account plane this host is registered to.
   */
  private async attach(request: HostRegistrationRequest): Promise<HostRegistrationStatus> {
    const registration = this.current()
    if (!registration) throw new HostRegistrationError('not-registered', 'This host is not registered to a Solus account.')
    if (normalizeOrigin(request.directoryUrl) !== normalizeOrigin(registration.directoryUrl)) {
      throw new HostRegistrationError('attach-rejected', `This host is registered to ${registration.directoryUrl}. Use a code from there.`)
    }
    const body: HostAttachRequest = { ticket: request.ticket }
    const response = await this.request(`${registration.directoryUrl}/v1/hosts/${registration.hostId}/organizations/attach`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await this.controlToken()}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      const detail = uplinkErrorBodySchema.safeParse(await response.json().catch(() => ({})))
      throw new HostRegistrationError('attach-rejected', attachRejectionMessage(response.status, detail.data?.error))
    }
    const attached = hostAttachResponseSchema.parse(await response.json())
    this.markAttached()
    log.info('host_attach_redeemed', { hostId: registration.hostId, organizations: attached.organizationIds.length })
    this.deps.onRegistrationChanged?.(this.current())
    return this.status()
  }

  /** Takes this host's organization attachment back for one organization; the registration, its records, and its other organizations stay. */
  async detach(organizationId: string): Promise<HostRegistrationStatus> {
    const registration = this.current()
    if (!registration) throw new HostRegistrationError('not-registered', 'This host is not registered to a Solus account.')
    const response = await this.request(`${registration.directoryUrl}/v1/hosts/${registration.hostId}/organizations/${encodeURIComponent(organizationId)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${await this.controlToken()}` },
    })
    if (response.status !== 204) throw new HostRegistrationError('attach-rejected', `Solus cloud refused to remove the organization (${response.status}).`)
    log.info('host_organization_detached', { hostId: registration.hostId, organizationId })
    this.deps.onRegistrationChanged?.(this.current())
    return this.status()
  }

  /**
   * Boot: a provisioned machine adopts the registration its environment carries; any
   * other checks its stored one with its control token (plan H4). Answers what Solus
   * cloud said about the host, so the link can follow it; null when it could not ask.
   */
  async resume(): Promise<HostLinkResponse | null> {
    return (await this.attemptResume()).remote
  }

  /**
   * Boot: `resume`, and `follow` gets the answer at once. When Solus cloud could not be
   * asked (no network yet, or a clock not yet set), `follow` gets null with
   * `isRetrying`, and the check is tried again after 30 s, then after twice the wait
   * each time up to 10 minutes, until Solus cloud answers or refuses the registration;
   * `follow` then gets that answer. `stopResuming` ends the retries.
   */
  async resumeUntilAnswered(follow: (remote: HostLinkResponse | null, isRetrying: boolean) => Promise<void>): Promise<void> {
    const attempt = await this.attemptResume()
    const isRetrying = attempt.isUnanswered && !this.isResumeStopped
    if (isRetrying) this.scheduleResumeRetry(follow, RESUME_RETRY_FIRST_MS)
    await follow(attempt.remote, isRetrying)
  }

  /** Shutdown: a boot check that waits to be tried again is not. */
  stopResuming(): void {
    this.isResumeStopped = true
    this.cancelResumeRetry?.()
    this.cancelResumeRetry = null
  }

  private scheduleResumeRetry(follow: (remote: HostLinkResponse | null, isRetrying: boolean) => Promise<void>, delayMs: number): void {
    log.info('host_registration_resume_retry_scheduled', { hostId: this.current()?.hostId ?? null, delayMs })
    const schedule = this.deps.schedule ?? scheduleTimer
    this.cancelResumeRetry = schedule(() => {
      this.cancelResumeRetry = null
      return this.retryResume(follow, delayMs)
    }, delayMs)
  }

  private async retryResume(follow: (remote: HostLinkResponse | null, isRetrying: boolean) => Promise<void>, lastDelayMs: number): Promise<void> {
    const attempt = await this.attemptResume()
    if (this.isResumeStopped) return
    if (attempt.isUnanswered) {
      // Only an answer is followed: the link already runs from what it stored.
      this.scheduleResumeRetry(follow, Math.min(lastDelayMs * 2, RESUME_RETRY_MAX_MS))
      return
    }
    log.info('host_registration_resume_answered', { hostId: this.current()?.hostId ?? null, registered: this.current() !== null })
    try {
      await follow(attempt.remote, false)
    } catch (error) {
      log.warn('host_registration_resume_follow_failed', { error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * One boot check. It is unanswered when Solus cloud could not be asked and the host
   * still holds its registration: a refusal forgets the registration, and that lasts.
   */
  private async attemptResume(): Promise<ResumeAttempt> {
    try {
      const env = this.deps.provisionedLink?.()
      if (env && (!this.persisted || env.registration.generation > this.persisted.registration.generation)) {
        await this.adoptProvisioned(env)
      }
      const remote = await this.check()
      return { remote, isUnanswered: remote === null && this.credential() !== null }
    } catch (error) {
      log.warn('host_registration_resume_failed', { error: error instanceof Error ? error.message : String(error) })
      return { remote: null, isUnanswered: error instanceof HostRegistrationError && error.code === 'control-plane-unreachable' }
    }
  }

  /**
   * The registration, its generation, and its link as Solus cloud knows them; null when it
   * could not ask or was refused. Also asked when another reader is refused (`HostOrganizations`):
   * a refused registration is forgotten, so the owner's client registers the host again (rule 8).
   */
  async check(): Promise<HostLinkResponse | null> {
    const registration = this.current()
    // The record says registered but the key is gone: the host cannot prove itself, and
    // its owner's client registers it (`needsRegistration`).
    if (!registration || !this.credential()) return null
    let token: string
    try {
      token = await this.controlToken()
    } catch (error) {
      log.warn('host_registration_check_failed', { error: error instanceof Error ? error.message : String(error) })
      return null
    }
    const response = await this.request(`${registration.directoryUrl}/v1/hosts/${registration.hostId}/link`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    }).catch(() => null)
    if (!response) return null
    // Removed from the account, or another copy of this host registered after it.
    if (response.status === 401 || response.status === 404) {
      this.forget()
      return null
    }
    if (!response.ok) return null
    const record = hostLinkResponseSchema.parse(await response.json())
    if (record.generation > registration.generation) {
      this.forget()
      return null
    }
    return record
  }

  /**
   * A provisioned host's first boot of a registration (managed-hosts.md §2, ADR 0001
   * §3.4): it makes its key, keeps it, and registers the public half with the one-time
   * ticket its boot carries. A boot that runs again before the answer came sends the
   * same key, which the control plane accepts. Only then is the registration stored.
   */
  private async adoptProvisioned(env: HostLinkEnv): Promise<void> {
    const { registration } = env
    const clientId = hostClientId(registration.hostId)
    const kept = loadHostKey()
    const privateJwk = kept && kept.generation === registration.generation && kept.clientId === clientId ? kept.privateJwk : (await generateHostKey()).privateJwk
    saveHostKey({ clientId, generation: registration.generation, privateJwk })
    const body: HostCredentialRequest = { credentialTicket: env.credentialTicket, publicJwk: publicJwkOf(privateJwk) }
    const response = await this.request(`${normalizeOrigin(registration.directoryUrl)}/v1/hosts/${registration.hostId}/credential`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    })
    if (response.status >= 500) {
      throw new HostRegistrationError('control-plane-unreachable', `Solus cloud could not take this machine's key (${response.status}).`)
    }
    if (!response.ok) {
      log.warn('provisioned_credential_refused', { hostId: registration.hostId, status: response.status })
      throw new HostRegistrationError('register-rejected', `Solus cloud refused this machine's key (${response.status}).`)
    }
    const registered = hostCredentialResponseSchema.parse(await response.json())
    this.store({ registration, key: { clientId: registered.oauthClient.clientId, privateJwk }, attached: false }, 'provisioned_registration_adopted')
  }

  /** What every registration ends with: the key to the secret store, the record to disk. */
  private store(
    input: { registration: HostRegistration; key: { clientId: string; privateJwk: PrivateJwk }; attached: boolean },
    event: 'host_registered' | 'provisioned_registration_adopted',
  ): void {
    const { registration } = input
    // The host will trust this issuer's keys, call this directory with its own
    // token, and deliver organization records to this API: only a private-network
    // origin may be plain http.
    for (const url of [registration.issuer, registration.jwksUrl, registration.directoryUrl, ...(registration.apiUrl ? [registration.apiUrl] : [])]) {
      if (!isSecureOrigin(url)) throw new HostRegistrationError('register-rejected', `Solus cloud named an insecure address (${url}); the host was not registered.`)
    }
    saveHostKey({ clientId: input.key.clientId, generation: registration.generation, privateJwk: input.key.privateJwk })
    // A registration that attached organizations is persisted as attached in the same write (organization-vms §4).
    const persisted: PersistedRegistration = { version: 1, registration }
    if (input.attached && hostCategory() === 'self-hosted') persisted.attachedAt = Date.now()
    this.setPersisted(persisted)
    log.info(event, { hostId: registration.hostId, generation: registration.generation })
  }

  /** Solus cloud refused the stored registration: the host is not registered (a deleted host is personal again). */
  private forget(): void {
    if (!this.persisted) return
    log.warn('host_registration_refused', { hostId: this.persisted.registration.hostId })
    forgetHostKey()
    this.heldCredential = null
    this.setPersisted(null)
  }

  private request(url: string, init: RequestInit): Promise<Response> {
    return (this.deps.fetchImpl ?? fetch)(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }).catch((err) => {
      throw new HostRegistrationError('control-plane-unreachable', `Solus cloud is not reachable: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  private setPersisted(next: PersistedRegistration | null): void {
    const changed = this.persisted?.registration.hostId !== next?.registration.hostId || this.persisted?.registration.generation !== next?.registration.generation
    this.persisted = next
    writePersistedRegistration(next)
    if (changed) this.deps.onRegistrationChanged?.(this.current())
    this.deps.onStatusChanged?.()
  }
}

function registerRejectionMessage(status: number, code: string | undefined): string {
  switch (code) {
    case 'invalid_ticket': return 'The registration ticket is invalid or has expired. Try again.'
    case 'not_a_member': return 'The account that made the code is no longer a member of that organization.'
    case 'personal_hosts_not_allowed': return 'That organization does not allow personal computers.'
    default: return `Solus cloud refused to register this host (${status}).`
  }
}

function attachRejectionMessage(status: number, code: string | undefined): string {
  switch (code) {
    case 'invalid_ticket': return 'The code is invalid, has expired, or was not made by this host\'s owner for an organization. Get a new code from Organization settings → Add your own VM.'
    case 'not_a_member': return 'The account that made the code is no longer a member of that organization.'
    case 'personal_hosts_not_allowed': return 'That organization does not allow personal computers.'
    default: return `Solus cloud refused to attach this host (${status}).`
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

function registrationFile(): string {
  return join(solusDir(), REGISTRATION_FILE)
}

/** The registration stored on disk, read before the registrar exists: what the boot needs to know about this machine before it listens. */
export function readStoredRegistration(): HostRegistration | null {
  return readPersistedRegistration()?.registration ?? null
}

/** Writes a registration record that a link record of an earlier version held (`transport/uplink/link.ts`). */
export function storeRegistrationRecord(registration: HostRegistration, attachedAt: number | undefined): void {
  writePersistedRegistration({ version: 1, registration, ...(attachedAt !== undefined ? { attachedAt } : {}) })
}

function readPersistedRegistration(): PersistedRegistration | null {
  const file = registrationFile()
  if (!existsSync(file)) return null
  try {
    const parsed = persistedRegistrationSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
    return parsed.success ? parsed.data : null
  } catch (err) {
    log.warn('host_registration_file_unreadable', { error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

function writePersistedRegistration(value: PersistedRegistration | null): void {
  const file = registrationFile()
  if (!value) {
    if (existsSync(file)) unlinkSync(file)
    return
  }
  const dir = solusDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 })
}

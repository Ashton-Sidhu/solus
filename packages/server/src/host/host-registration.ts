import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import type { HostOperatingSystem } from '@solus/contracts/types'
import {
  enrollHostResponseSchema,
  hostLinkResponseSchema,
  hostRegistrationSchema,
  isOrganizationTicket,
  parseLinkCode,
  tokenEndpoint,
  uplinkErrorBodySchema,
  type EnrollHostRequest,
  type HostLinkResponse,
  type HostOwnerIdentity,
  type HostRegistration,
  type HostRegistrationRequest,
  type HostRegistrationStatus,
} from '@solus/contracts/uplink'
import type { FetchLike } from '../admission/access-tokens'
import { createLogger } from '../logger'
import { solusDir } from '../platform/paths'
import type { BootLinkCode } from './boot-link-code'
import type { CloudMachineFacts } from './machine-kind'
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
/** What the data directory remembers of a cloud machine after its registration ended. Never removed. */
const CLOUD_MACHINE_FILE = 'cloud-machine.json'
/** A boot enrollment that Solus cloud did not answer is tried again after this, then after twice the wait each time. */
const BOOT_ENROLL_RETRY_FIRST_MS = 5_000
const BOOT_ENROLL_RETRY_MAX_MS = 60_000
/** The organization of a cloud machine whose record cannot be read: it matches no real one, so nobody starts work until an operator repairs the directory. */
const UNREADABLE_CLOUD_ORGANIZATION = 'unreadable-cloud-machine-record'
const REQUEST_TIMEOUT_MS = 10_000
/** A boot check Solus cloud did not answer is asked again after this, then after twice the wait each time. */
const RESUME_RETRY_FIRST_MS = 30_000
/** The longest wait between two boot checks: Solus cloud is never asked more often than this once the waits have grown. */
const RESUME_RETRY_MAX_MS = 10 * 60_000

const persistedRegistrationSchema = z.object({
  version: z.literal(1),
  registration: hostRegistrationSchema,
}).strict()
type PersistedRegistration = z.infer<typeof persistedRegistrationSchema>

const cloudMachineSchema = z.object({
  version: z.literal(1),
  organizationId: z.string().min(1),
  hasManagedCompute: z.boolean().optional(),
}).strict()

/** The facts of this machine that every enrollment sends. */
interface MachineFacts {
  installationId: string
  label: string
  os: HostOperatingSystem | undefined
}

/** What an enrollment gives: the registration record, and the host's OAuth client with the key it made. */
interface Enrollment {
  registration: HostRegistration
  key: { clientId: string; privateJwk: PrivateJwk }
}

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
  /**
   * Whether this host holds work already: session records of the person who ran it. A
   * cloud machine starts with new data (plans/034-one-cloud-machine-kind.md §3), so an
   * organization code is refused on a host that does.
   */
  holdsWork?: () => Promise<boolean>
  /** This server is the desktop app's own: a person's computer always, which takes no organization ticket. */
  isDesktopApp?: () => boolean
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
  constructor(readonly code: 'not-registered' | 'register-rejected' | 'control-plane-unreachable', message: string) {
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

  status(): HostRegistrationStatus {
    if (!this.persisted) return { registered: false }
    return { registered: true, registration: this.persisted.registration, owner: this.deps.owner() }
  }

  /**
   * Registers this host with a ticket its owner's client got with its own account
   * token (rule 8). No tunnel is made. A host registered already ignores a personal
   * ticket: two clients that both saw an unregistered host register it once. An
   * organization ticket makes this machine a cloud machine
   * (plans/034-one-cloud-machine-kind.md §3): it is refused on a host that is registered
   * or that holds work, before the one-use ticket is sent.
   */
  register(request: HostRegistrationRequest): Promise<HostRegistrationStatus> {
    const run = (this.registering ?? Promise.resolve(this.status()))
      .catch(() => this.status())
      .then(() => this.registerNow(request))
    this.registering = run
    return run.finally(() => { if (this.registering === run) this.registering = null })
  }

  private async registerNow(request: HostRegistrationRequest): Promise<HostRegistrationStatus> {
    const isRegistered = this.persisted !== null && this.credential() !== null
    assertTicketFitsDataDirectory(request.ticket)
    if (isOrganizationTicket(request.ticket)) {
      if (this.deps.isDesktopApp?.()) throw new HostRegistrationError('register-rejected', 'The server of the desktop app is a personal computer always. An organization code makes a standalone Solus server a cloud host.')
      if (isRegistered) throw new HostRegistrationError('register-rejected', 'This server is registered already. A cloud machine starts with new data: use a new data directory.')
      if (!readStoredCloudMachine() && await this.deps.holdsWork?.()) throw new HostRegistrationError('register-rejected', 'This server holds sessions already. A cloud machine starts with new data: use a new data directory.')
    } else if (isRegistered) {
      return this.status()
    }
    const facts: MachineFacts = { installationId: this.deps.installationId(), label: this.deps.hostLabel(), os: this.deps.os() }
    // Each registration has a new key: registering again rotates it, and the old one proves nothing.
    const enrollment = await enroll(request, facts, (await generateHostKey()).privateJwk, this.deps.fetchImpl)
    storeEnrollment(enrollment)
    this.setPersisted({ version: 1, registration: enrollment.registration })
    log.info('host_registered', { hostId: enrollment.registration.hostId, generation: enrollment.registration.generation })
    return this.status()
  }

  /**
   * Boot: the host checks its stored registration with its control token (plan H4).
   * Answers what Solus cloud said about the host, so the link can follow it; null when
   * it could not ask.
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

  /** Solus cloud refused the stored registration: the host is not registered. A cloud machine stays a cloud machine (`machine-kind.ts`). */
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

/**
 * One enrollment (`POST /v1/hosts/enroll`): the ticket, what this machine is, and the
 * public half of the key it made. Every machine joins this way: a person's own
 * computer, a cloud machine that an operator runs, and one that a compute provider
 * made (plans/034-one-cloud-machine-kind.md §3). A refusal is `register-rejected`;
 * a control plane that did not answer, or answered a server error, is
 * `control-plane-unreachable`, so the caller may try the same ticket again.
 */
async function enroll(request: HostRegistrationRequest, machine: MachineFacts, privateJwk: PrivateJwk, fetchImpl: FetchLike = fetch): Promise<Enrollment> {
  const body: EnrollHostRequest = {
    ticket: request.ticket,
    installationId: machine.installationId,
    label: machine.label,
    os: machine.os,
    publicJwk: publicJwkOf(privateJwk),
  }
  if (request.address) body.address = request.address
  const response = await fetchImpl(`${normalizeOrigin(request.directoryUrl)}/v1/hosts/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch((err) => {
    throw new HostRegistrationError('control-plane-unreachable', `Solus cloud is not reachable: ${err instanceof Error ? err.message : String(err)}`)
  })
  if (response.status >= 500) throw new HostRegistrationError('control-plane-unreachable', `Solus cloud could not register this host (${response.status}).`)
  if (!response.ok) {
    const detail = uplinkErrorBodySchema.safeParse(await response.json().catch(() => ({})))
    throw new HostRegistrationError('register-rejected', registerRejectionMessage(response.status, detail.data?.error))
  }
  const enrolled = enrollHostResponseSchema.parse(await response.json())
  return { registration: enrolled.registration, key: { clientId: enrolled.oauthClient.clientId, privateJwk } }
}

/**
 * What every enrollment ends with, before the registration record is written: the
 * addresses are checked, the key goes to the secret store, and a cloud machine's data
 * directory remembers its organization.
 */
function storeEnrollment(enrollment: Enrollment): void {
  const { registration } = enrollment
  // The host will trust this issuer's keys, call this directory with its own
  // token, and deliver organization records to this API: only a private-network
  // origin may be plain http.
  for (const url of [registration.issuer, registration.jwksUrl, registration.directoryUrl, ...(registration.apiUrl ? [registration.apiUrl] : [])]) {
    if (!isSecureOrigin(url)) throw new HostRegistrationError('register-rejected', `Solus cloud named an insecure address (${url}); the host was not registered.`)
  }
  const remembered = readStoredCloudMachine()
  if (remembered && remembered.organizationId !== registration.organizationId) {
    throw new HostRegistrationError('register-rejected', 'This data directory belongs to a cloud machine of another organization. Use a new data directory.')
  }
  saveHostKey({ clientId: enrollment.key.clientId, generation: registration.generation, privateJwk: enrollment.key.privateJwk })
  if (registration.organizationId) writeCloudMachine({ organizationId: registration.organizationId, hasManagedCompute: registration.hasManagedCompute })
}

/** A data directory of a cloud machine takes no personal ticket: its data is its organization's. Checked before the one-use ticket is sent. */
function assertTicketFitsDataDirectory(ticket: string): void {
  if (readStoredCloudMachine() && !isOrganizationTicket(ticket)) {
    throw new HostRegistrationError('register-rejected', 'This data directory belongs to a cloud machine. A personal link needs a new data directory.')
  }
}

/**
 * A machine with a link code in its environment enrolls here, before the server opens
 * a listener (plans/034-one-cloud-machine-kind.md §3): the control plane made it
 * through a compute provider, or a script starts it. So the process
 * knows what it is before any door exists, and a cloud machine never has a
 * credential-free door, also for a moment.
 *
 * A machine that is registered already keeps its registration: the code of an earlier
 * boot stays in a provider's boot input. Solus cloud not answering is tried again for
 * as long as it takes; a refusal ends the boot, and the provider shows the failure.
 * Answers the new registration, or null when nothing was to do.
 */
export async function enrollAtBoot(input: { code: BootLinkCode; machine: MachineFacts; holdsWork?: () => Promise<boolean>; fetchImpl?: FetchLike; wait?: (delayMs: number) => Promise<void> }): Promise<HostRegistration | null> {
  const stored = readPersistedRegistration()?.registration
  // The same test as `HostRegistrar.credential`: a key of another generation proves nothing.
  if (stored && loadHostKey()?.generation === stored.generation) return null
  if (!input.code.code.includes('@')) throw new HostRegistrationError('register-rejected', 'The link code in the environment does not name its Solus cloud.')
  // The fallback origin is never used: the code names its own.
  const request: HostRegistrationRequest = parseLinkCode(input.code.code, 'https://invalid.invalid')
  if (input.code.address) request.address = input.code.address
  assertTicketFitsDataDirectory(request.ticket)
  // The same rule as for a person's organization code: a cloud machine starts with new data.
  if (isOrganizationTicket(request.ticket) && !readStoredCloudMachine() && await input.holdsWork?.()) {
    throw new HostRegistrationError('register-rejected', 'This server holds sessions already. A cloud machine starts with new data: use a new data directory.')
  }
  const wait = input.wait ?? ((delayMs: number) => new Promise<void>((resolve) => { setTimeout(resolve, delayMs) }))
  // One key for every attempt: Solus cloud answers a ticket again for the key that it registered with it.
  const { privateJwk } = await generateHostKey()
  for (let delayMs = BOOT_ENROLL_RETRY_FIRST_MS; ; delayMs = Math.min(delayMs * 2, BOOT_ENROLL_RETRY_MAX_MS)) {
    try {
      const enrollment = await enroll(request, input.machine, privateJwk, input.fetchImpl)
      storeEnrollment(enrollment)
      writePersistedRegistration({ version: 1, registration: enrollment.registration })
      log.info('host_enrolled_at_boot', { hostId: enrollment.registration.hostId, generation: enrollment.registration.generation, organizationId: enrollment.registration.organizationId ?? null })
      return enrollment.registration
    } catch (error) {
      if (!(error instanceof HostRegistrationError) || error.code !== 'control-plane-unreachable') throw error
      log.warn('host_boot_enrollment_retry_scheduled', { delayMs, error: error.message })
      await wait(delayMs)
    }
  }
}

function registerRejectionMessage(status: number, code: string | undefined): string {
  switch (code) {
    case 'invalid_ticket': return 'The registration ticket is invalid or has expired. Try again.'
    case 'not_a_member': return 'The account that made the code is no longer a member of that organization.'
    case 'personal_hosts_not_allowed': return 'That organization does not allow personal computers.'
    case 'refused_by_host_policy': return 'That organization does not allow cloud machines.'
    case 'machine_address_invalid': return 'The address of this machine is not valid. Give an `https://` address with no path, for example `--address https://machine.example.com`.'
    case 'tunnel_not_configured': return 'This Solus cloud has no tunnels. Give the HTTPS address of this machine with `--address`.'
    default: return `Solus cloud refused to register this host (${status}).`
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

/**
 * What this data directory remembers of the cloud machine it is or was: its one
 * organization. Written at each enrollment of a cloud machine and never removed, so a
 * machine whose registration ended does not become a personal machine with its
 * organization's data on it (plans/034-one-cloud-machine-kind.md §2).
 */
export function readStoredCloudMachine(): CloudMachineFacts | null {
  const file = join(solusDir(), CLOUD_MACHINE_FILE)
  if (!existsSync(file)) return null
  try {
    const parsed = cloudMachineSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
    if (parsed.success) return { organizationId: parsed.data.organizationId, hasManagedCompute: parsed.data.hasManagedCompute }
    log.warn('cloud_machine_file_unreadable', { issues: parsed.error.issues.map((issue) => issue.path.join('.')) })
  } catch (err) {
    log.warn('cloud_machine_file_unreadable', { error: err instanceof Error ? err.message : String(err) })
  }
  // A file that exists but cannot be read still says "a cloud machine": no door opens on a guess.
  return { organizationId: UNREADABLE_CLOUD_ORGANIZATION }
}

function writeCloudMachine(facts: { organizationId: string; hasManagedCompute: boolean | undefined }): void {
  const dir = solusDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const record: z.infer<typeof cloudMachineSchema> = { version: 1, organizationId: facts.organizationId }
  if (facts.hasManagedCompute) record.hasManagedCompute = true
  writeFileSync(join(dir, CLOUD_MACHINE_FILE), JSON.stringify(record, null, 2), { mode: 0o600 })
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

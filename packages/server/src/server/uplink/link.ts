import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import type { HostOperatingSystem } from '@solus/contracts/types'
import {
  enrollHostResponseSchema,
  hostLinkResponseSchema,
  uplinkDesiredStateSchema,
  uplinkErrorBodySchema,
  uplinkLinkConfigSchema,
  type EnrollHostRequest,
  type UplinkLinkConfig,
  type UplinkLinkRequest,
  type UplinkLinkState,
  type UplinkObservedState,
  type UplinkStatus,
} from '@solus/contracts/uplink'
import { createLogger } from '../../logger'
import { dataDir, solusDir } from '../../platform/paths'
import { secretStore } from '../../platform/secrets'
import type { FetchLike } from '../host-grants'
import type { ConnectorObservation } from './connector'

const log = createLogger('main', 'uplink-link')

/**
 * The host's side of the cloud link (docs/plans/personal-uplink.md, H2 and H4).
 *
 * Durable state is two files: the non-secret link record with the *desired* state in
 * `SOLUS_DATA_DIR/uplink-link.json`, and the two tokens in the secret store. Every
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
}).strict()
const tokensSchema = z.object({
  connectorToken: z.string().min(1),
  hostToken: z.string().min(1),
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
  fetchImpl?: FetchLike
}

export class UplinkLinkError extends Error {
  constructor(readonly code: 'already-linked' | 'not-linked' | 'enroll-rejected' | 'control-plane-unreachable', message: string) {
    super(message)
    this.name = 'UplinkLinkError'
  }
}

export class UplinkLinkManager {
  private persisted: PersistedLink | null
  private observed: UplinkObservedState = 'offline'
  private observedError: string | undefined

  constructor(private readonly deps: UplinkLinkDeps) {
    this.persisted = readPersistedLink()
  }

  currentLink(): UplinkLinkConfig | null {
    return this.persisted?.desired === 'linked' ? this.persisted.link : null
  }

  status(): UplinkStatus {
    if (!this.persisted || this.persisted.desired !== 'linked') return { linked: false }
    const state: UplinkLinkState = this.observedError
      ? { observed: this.observed, error: this.observedError }
      : { observed: this.observed }
    return { linked: true, link: this.persisted.link, state }
  }

  /** Enroll with the control plane and start the connector. */
  async link(request: UplinkLinkRequest): Promise<UplinkStatus> {
    if (this.persisted?.desired === 'linked') throw new UplinkLinkError('already-linked', 'This host is already linked. Unlink it first.')
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
    const body: EnrollHostRequest = {
      ticket: request.ticket,
      installationId: this.deps.installationId(),
      label: this.deps.hostLabel(),
      os: this.deps.os(),
      proxiedPort: this.deps.proxiedPort(),
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
    // The host will trust this issuer's keys and call this directory with its own
    // token: only a private-network origin may be plain http.
    for (const url of [enrolled.link.issuer, enrolled.link.jwksUrl, enrolled.link.directoryUrl]) {
      if (!isSecureOrigin(url)) throw new UplinkLinkError('enroll-rejected', `Solus cloud named an insecure address (${url}); the link was not made.`)
    }
    secretStore().saveJson(TOKENS_KEY, tokensElectronPath(), { connectorToken: enrolled.connectorToken, hostToken: enrolled.hostToken })
    this.setPersisted({ version: 1, desired: 'linked', link: enrolled.link })
    this.setObservation({ observed: 'offline' })
    this.deps.connector.start(enrolled.connectorToken)
    log.info('uplink_linked', { hostId: enrolled.link.hostId, hostname: enrolled.link.hostname, generation: enrolled.link.connectionGeneration })
    return this.status()
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
    if (!this.persisted) return
    if (this.persisted.desired === 'unlinked') {
      await this.completeUnlink()
      return
    }
    const tokens = this.loadTokens()
    if (!tokens) {
      // The record says linked but the credentials are gone: the host cannot run the
      // tunnel or prove itself. Surface it; the owner re-links.
      this.setObservation({ observed: 'error', error: 'Link credentials are missing; link this host again.' })
      return
    }
    const { proxiedPort } = this.persisted.link
    if (this.deps.proxiedPort() !== proxiedPort) {
      // The tunnel's ingress points at a port this host could not bind. Running the
      // connector would only make every request 502; say so instead.
      this.setObservation({ observed: 'error', error: `Port ${proxiedPort} is in use on this host, so the tunnel cannot reach it. Free the port and restart Solus, or unlink and link again.` })
      return
    }
    const verdict = await this.checkGeneration(tokens)
    if (verdict === 'current') this.deps.connector.start(tokens.connectorToken)
  }

  handleConnectorObservation(observation: ConnectorObservation): void {
    // A superseded host keeps its verdict; the connector's last gasp must not overwrite it.
    if (this.observedError === SUPERSEDED_MESSAGE) return
    this.setObservation(observation)
  }

  private async completeUnlink(): Promise<void> {
    const persisted = this.persisted
    if (!persisted) return
    const tokens = this.loadTokens()
    if (tokens) {
      let done = false
      try {
        const response = await this.request(`${persisted.link.directoryUrl}/v1/hosts/${persisted.link.hostId}/link`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${tokens.hostToken}` },
        })
        // 401 means the control plane no longer knows this token: the unlink already
        // happened, or a newer generation superseded this copy. Either way, done here.
        done = response.status === 204 || response.status === 401 || response.status === 404
        if (!done) log.warn('uplink_unlink_rejected', { status: response.status })
      } catch (err) {
        log.warn('uplink_unlink_deferred', { error: err instanceof Error ? err.message : String(err) })
      }
      if (!done) return
      secretStore().remove(TOKENS_KEY, tokensElectronPath())
    }
    this.setPersisted(null)
    this.setObservation({ observed: 'offline' })
    log.info('uplink_unlinked', { hostId: persisted.link.hostId })
  }

  /** H4: only the current generation's token is accepted; a restored copy learns it was superseded here. */
  private async checkGeneration(tokens: UplinkTokens): Promise<'current' | 'superseded' | 'unknown'> {
    const link = this.currentLink()
    if (!link) return 'unknown'
    try {
      const response = await this.request(`${link.directoryUrl}/v1/hosts/${link.hostId}/link`, {
        headers: { authorization: `Bearer ${tokens.hostToken}`, accept: 'application/json' },
      })
      if (response.status === 401 || response.status === 404) return this.markSuperseded()
      if (!response.ok) return 'unknown'
      const record = hostLinkResponseSchema.parse(await response.json())
      if (record.connectionGeneration > link.connectionGeneration || record.desired !== 'linked') {
        return this.markSuperseded()
      }
      return 'current'
    } catch (err) {
      log.warn('uplink_generation_check_failed', { error: err instanceof Error ? err.message : String(err) })
      return 'unknown'
    }
  }

  private markSuperseded(): 'superseded' {
    log.warn('uplink_superseded', { hostId: this.persisted?.link.hostId ?? null })
    this.setObservation({ observed: 'error', error: SUPERSEDED_MESSAGE })
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
  }

  private setObservation(observation: ConnectorObservation): void {
    this.observed = observation.observed
    this.observedError = observation.observed === 'error' ? observation.error : undefined
  }
}

export const SUPERSEDED_MESSAGE = 'Another copy of this host holds the link; link this host again to take it over.'

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

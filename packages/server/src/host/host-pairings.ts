import { carriesTokenInClear, routeForUrl } from '@solus/contracts/host-routes'
import { z } from 'zod'
import { classifyPairSecret, pairServer, normalizeServerUrl, requestPairApproval, type PairServerResult } from '@solus/client-core/pairing'
import { normalizeCheckCode } from '@solus/contracts/add-machine'
import { listingOf } from '@solus/client-core/host-join'
import { answersAsSavedHost } from '@solus/client-core/host-link'
import { readHostHealth, refreshHostSession } from '@solus/client-core/host-http'
import { dialHostSocket } from '@solus/client-core/host-socket'
import { hostPairRequestSchema, type HostPairRequest, type HostPairingsSnapshot, type HostClientPairing } from '@solus/contracts/host-pairing'
import type { HostListing } from '@solus/contracts/host-list'
import { SESSION_TOKEN_TTL_MS } from '../admission/auth'
import { announceHostRecordsChanged, findHostRecord, hostCredential, readHostRecords, clearHostCredential, removeHostListing, saveHostConnection } from './host-list'

const TIMEOUT_MS = 5_000
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000
const codeSchema = z.object({ token: z.string().min(1) })

function pairingUrl(input: string): string {
  const parsed = new URL(normalizeServerUrl(input))
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || !['', '/'].includes(parsed.pathname)) {
    throw new Error('Use an HTTP or HTTPS server address with no credentials, path, query, or fragment.')
  }
  const url = parsed.origin
  const route = routeForUrl(url)
  if (route.kind !== 'lan' && carriesTokenInClear(route)) throw new Error('Use HTTPS for a host outside the local network.')
  return url
}

/** What `pair` sends: the token of a pair link, or a 6-digit code. Anything else (a password) is refused before any request. */
function pairingSecret(url: string, code: string): string {
  const secret = classifyPairSecret(code)
  if (!secret) throw new Error('That is not a pairing code. A pairing code is 6 digits or a pair link. Nothing was sent.')
  if (secret.kind === 'code') return secret.code
  if (normalizeServerUrl(secret.url) !== url) throw new Error('The pairing link names a different server. Use the address from that link.')
  return secret.pairToken
}

/** The check code that the caller shows for an approval request, in its one written form. */
function approvalCheckCode(value: string | undefined): string {
  const checkCode = value === undefined ? null : normalizeCheckCode(value)
  if (!checkCode) throw new Error('That is not a check code. A check code is 8 letters and digits, such as K7QM-2XFD.')
  return checkCode
}

/** The host to pair, checked before any secret goes to it. */
interface PairingTarget {
  url: string
  name: string
  installationId: string
  generation: number
  before: ReturnType<typeof findHostRecord>
  replaced: string | undefined
}

/** Explicit local reach for the owner. The host keeps its credential; each client gets a new one. */
export class HostPairings {
  // A forget or a second pair invalidates a pair that is still in flight.
  private readonly generations = new Map<string, number>()
  private readonly renewals = new Map<string, Promise<string | null>>()
  /** What this process saw of each pairing: when the machine last accepted the credential, and why the last use failed. */
  private readonly uses = new Map<string, { reachedAt?: number; error: string | null }>()
  constructor(
    private readonly selfId: () => string,
    private readonly selfName: () => string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now = Date.now,
    /** The requester side of an approval request; tests give their own. */
    private readonly approve: typeof requestPairApproval = requestPairApproval,
  ) {}

  snapshot(): HostPairingsSnapshot {
    const records = readHostRecords()
    return {
      hosts: records.flatMap((record) => !record.forgotten && record.pairing ? [{
        listing: record.listing, pairedAt: record.pairing.pairedAt, url: record.pairing.url,
      }] : []),
      forgotten: records.filter((record) => record.forgotten).map((record) => record.listing.installationId),
    }
  }

  /**
   * The owner's list of pairings, each with its health (docs/host-pairing.md,
   * "Pairing health"): what its uses showed, and when its credential ends. Nothing
   * is dialed. A change of a pairing's error announces the list again.
   */
  listed(): HostPairingsSnapshot {
    const now = this.now()
    const snapshot = this.snapshot()
    return {
      ...snapshot,
      hosts: snapshot.hosts.map((host) => {
        const installationId = host.listing.installationId
        const refreshedAt = findHostRecord(installationId)?.pairing?.refreshedAt ?? host.pairedAt
        const use = this.uses.get(installationId)
        const expiresAt = refreshedAt + SESSION_TOKEN_TTL_MS
        const hasEnded = expiresAt <= now || !hostCredential(installationId, 'pairing')
        return { ...host, health: { lastReachedAt: Math.max(use?.reachedAt ?? 0, refreshedAt), lastError: use?.error ?? null, expiresAt: hasEnded ? null : expiresAt } }
      }),
    }
  }

  /** Records one use of a pairing: null when the machine accepted the credential, else why the use failed. */
  noteUse(installationId: string, error: string | null): void {
    const known = this.uses.get(installationId)
    this.uses.set(installationId, error === null ? { reachedAt: this.now(), error: null } : { reachedAt: known?.reachedAt, error })
    // Clients follow the list: a pairing that starts or stops failing is news; another good use is not.
    if ((known?.error ?? null) !== error) announceHostRecordsChanged()
  }

  /**
   * Pairs with the host at `request.url`, with its pairing code or link, or with
   * a check code: an approval request that the host's owner approves there
   * (docs/plans/add-machine-card.md). Both are saved the same way.
   */
  async pair(input: HostPairRequest, signal?: AbortSignal): Promise<HostListing> {
    const request = hostPairRequestSchema.parse(input)
    const url = pairingUrl(request.url)
    // The shape check comes before any request: a value that is not a code goes nowhere.
    const way: { pairToken: string } | { checkCode: string } = request.code !== undefined ? { pairToken: pairingSecret(url, request.code) } : { checkCode: approvalCheckCode(request.checkCode) }
    const target = await this.target(url, signal)
    const result = 'pairToken' in way
      ? await this.pairWithCode(target, way.pairToken, request.label, signal)
      : await this.pairByApproval(target, way.checkCode, request.label, signal)
    return this.save(target, result, signal)
  }

  private async pairWithCode(target: PairingTarget, pairToken: string, label: string | undefined, signal?: AbortSignal): Promise<PairServerResult> {
    // A bounded request, with no redirects: a pairing code must reach only the named address.
    const fetchPair: typeof fetch = async (input, init) => {
      const timeout = AbortSignal.timeout(TIMEOUT_MS)
      const pairSignal = signal ? AbortSignal.any([timeout, signal]) : timeout
      let response: Response
      try {
        response = await this.fetchImpl(input, { ...init, redirect: 'error', signal: pairSignal })
      } catch {
        if (signal?.aborted) throw new Error('Pairing was canceled.')
        if (timeout.aborted) throw new Error('The host did not answer the pairing request in time.')
        throw new Error('Could not send the pairing request to the host.')
      }
      if (response.ok) return response
      // A remote error body can contain the code. Report the HTTP status only.
      void response.body?.cancel().catch(() => {})
      if (response.status === 401) throw new Error('The host did not accept the pairing code (HTTP 401). Run solus pair on that host for a new code.')
      if (response.status === 429) throw new Error('Too many pairing attempts (HTTP 429). Wait before you try again.')
      throw new Error(`The host returned HTTP ${response.status} for the pairing request.`)
    }
    return pairServer({ url: target.url, pairToken, serverLabel: label, reportedName: target.name, deviceLabel: this.deviceLabel(), replacesSessionToken: target.replaced, fetchImpl: fetchPair })
  }

  /** No code: the target's owner approves the request that shows `checkCode`. */
  private async pairByApproval(target: PairingTarget, checkCode: string, label: string | undefined, signal?: AbortSignal): Promise<PairServerResult> {
    // No redirects. The wait is a long poll, so `requestPairApproval` sets the time limit of each call.
    const fetchApproval: typeof fetch = (input, init) => this.fetchImpl(input, { ...init, redirect: 'error' })
    const answer = await this.approve({ url: target.url, checkCode, serverLabel: label, reportedName: target.name, deviceLabel: this.deviceLabel(), replacesSessionToken: target.replaced, fetchImpl: fetchApproval, signal })
    if (answer.status === 'denied') throw new Error('The owner of that host denied the request.')
    if (answer.status === 'expired') throw new Error('Nobody approved the request before it expired. Ask again.')
    if (answer.status === 'unavailable') throw new Error('That host does not take approval requests. Use a pairing code.')
    return answer.result
  }

  /** The host at `url`, as its health check names it; never this host. */
  private async target(url: string, signal?: AbortSignal): Promise<PairingTarget> {
    const health = await readHostHealth(this.fetchImpl, url, AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), ...(signal ? [signal] : [])]))
    if (!health) throw new Error('The Solus host did not answer its health check.')
    if (health.installationId === this.selfId()) throw new Error('This is the current host. It cannot pair with itself.')
    const installationId = health.installationId
    return {
      url,
      name: health.name,
      installationId,
      generation: this.nextGeneration(installationId),
      before: findHostRecord(installationId),
      replaced: hostCredential(installationId, 'pairing') ?? undefined,
    }
  }

  private async save(target: PairingTarget, result: PairServerResult, signal?: AbortSignal): Promise<HostListing> {
    const { url, installationId } = target
    if (result.installationId !== installationId) throw new Error('A different host answered the pairing request. Nothing was saved.')
    if (!result.server.identityKey && url.startsWith('http:')) throw new Error('This host is too old to prove its identity over HTTP. Update it or use HTTPS.')
    if (signal?.aborted || this.generations.get(installationId) !== target.generation || findHostRecord(installationId)?.forgotten && !target.before?.forgotten) {
      throw new Error('Pairing ended before it could be saved. Pair again if you still want access.')
    }
    const { sessionToken } = result.server
    const listing = listingOf(result.server)
    if (!listing) throw new Error('The pairing reply did not name a remote host.')
    const now = this.now()
    saveHostConnection(listing, { kind: 'pairing', token: sessionToken, settings: { url, pairedAt: now, refreshedAt: now } })
    this.uses.delete(installationId)
    return findHostRecord(installationId)!.listing
  }

  private deviceLabel(): string {
    return `${this.selfName()} (Solus host)`
  }

  forget(installationId: string): boolean {
    this.nextGeneration(installationId)
    this.uses.delete(installationId)
    return removeHostListing(installationId)
  }

  /** A token goes only to the saved host, and a late refresh cannot restore a forgotten connection. */
  async credential(installationId: string): Promise<string | null> {
    const record = findHostRecord(installationId)
    const connection = record?.pairing
    const token = hostCredential(installationId, 'pairing')
    if (!record || !connection || !token) return null
    if (!await answersAsSavedHost(this.fetchImpl, { url: connection.url }, record.listing, AbortSignal.timeout(TIMEOUT_MS))) {
      this.noteUse(installationId, `It did not answer as ${record.listing.label} at ${connection.url}.`)
      return null
    }
    if (hostCredential(installationId, 'pairing') !== token) return null
    if (this.now() - connection.refreshedAt < REFRESH_AFTER_MS) return token
    const refreshed = await refreshHostSession(this.fetchImpl, connection.url, token, TIMEOUT_MS)
    if (hostCredential(installationId, 'pairing') !== token) return null
    if (refreshed.result === 'unauthorized') {
      clearHostCredential(installationId, 'pairing')
      this.noteUse(installationId, 'It refused the credential of this pairing. Pair it again.')
      return null
    }
    if (refreshed.result !== 'refreshed') return token
    saveHostConnection(record.listing, { kind: 'pairing', token: refreshed.sessionToken, settings: { ...connection, refreshedAt: this.now() } })
    this.noteUse(installationId, null)
    return refreshed.sessionToken
  }

  /** A connection can stay open longer than the token's idle lifetime. Renew
   * when it is used, at the same cadence as a fresh dial. */
  async renewOnUse(installationId: string): Promise<boolean> {
    const record = findHostRecord(installationId)
    if (!record?.pairing || record.forgotten) return false
    if (this.now() - record.pairing.refreshedAt < REFRESH_AFTER_MS) return true
    let renewal = this.renewals.get(installationId)
    if (!renewal) {
      renewal = this.credential(installationId).finally(() => this.renewals.delete(installationId))
      this.renewals.set(installationId, renewal)
    }
    return (await renewal) !== null
  }

  /** The client's own pairing uses a fresh code; the persistent host credential never leaves this process. */
  async forClient(installationId: string): Promise<HostClientPairing> {
    const token = await this.credential(installationId)
    const record = findHostRecord(installationId)
    if (!token || !record?.pairing) throw new Error('This host no longer has access to that machine. Pair it again.')
    const url = record.pairing.url
    const dialed = await dialHostSocket(url, { credential: { kind: 'session-token', token } }, { timeoutMs: TIMEOUT_MS })
    if (!dialed.ok) {
      this.noteUse(installationId, dialed.code === 'UNAUTHORIZED' ? 'It refused the credential of this pairing. Pair it again.' : `It did not accept a connection at ${url}.`)
      throw new Error('The remote host refused this connection. Pair it again.')
    }
    this.noteUse(installationId, null)
    try {
      const result = await dialed.socket.call('connectionsGeneratePairToken', [], TIMEOUT_MS)
      if (result.error) throw new Error('The remote host could not create a client pairing code.')
      const code = codeSchema.parse(result.result).token
      if (hostCredential(installationId, 'pairing') !== token) throw new Error('This host was forgotten while the code was made.')
      return { listing: record.listing, url, code }
    } finally { dialed.socket.close() }
  }

  private nextGeneration(installationId: string): number {
    const generation = (this.generations.get(installationId) ?? 0) + 1
    this.generations.set(installationId, generation)
    return generation
  }
}

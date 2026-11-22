import { carriesTokenInClear, routeForUrl } from '@solus/contracts/host-routes'
import { z } from 'zod'
import { pairServer, normalizeServerUrl } from '@solus/client-core/pairing'
import { listingOf } from '@solus/client-core/host-join'
import { answersAsSavedHost } from '@solus/client-core/host-link'
import { readHostHealth, refreshHostSession } from '@solus/client-core/host-http'
import { dialHostSocket } from '@solus/client-core/host-socket'
import { hostPairRequestSchema, type HostPairRequest, type HostPairingsSnapshot, type HostClientPairing } from '@solus/contracts/host-pairing'
import type { HostListing } from '@solus/contracts/host-list'
import { findHostRecord, hostCredential, readHostRecords, clearHostCredential, removeHostListing, saveHostConnection } from './host-list'

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

/** Explicit local reach for the owner. The host keeps its credential; each client gets a new one. */
export class HostPairings {
  // A forget or a second pair invalidates a pair that is still in flight.
  private readonly generations = new Map<string, number>()
  constructor(private readonly selfId: () => string, private readonly selfName: () => string, private readonly fetchImpl: typeof fetch = fetch, private readonly now = Date.now) {}

  snapshot(): HostPairingsSnapshot {
    const records = readHostRecords()
    return {
      hosts: records.flatMap((record) => !record.forgotten && record.pairing ? [{ listing: record.listing, pairedAt: record.pairing.pairedAt }] : []),
      forgotten: records.filter((record) => record.forgotten).map((record) => record.listing.installationId),
    }
  }

  async pair(input: HostPairRequest, signal?: AbortSignal): Promise<HostListing> {
    const request = hostPairRequestSchema.parse(input)
    const url = pairingUrl(request.url)
    const health = await readHostHealth(this.fetchImpl, url, AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), ...(signal ? [signal] : [])]))
    if (!health) throw new Error('The Solus host did not answer its health check.')
    if (health.installationId === this.selfId()) throw new Error('This is the current host. It cannot pair with itself.')
    const installationId = health.installationId
    const generation = this.nextGeneration(installationId)
    const before = findHostRecord(installationId)
    // A bounded request, with no redirects: a pairing code must reach only the named address.
    const fetchPair: typeof fetch = (input, init) => this.fetchImpl(input, { ...init, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), ...(signal ? [signal] : [])]) })
    const replaced = hostCredential(installationId, 'pairing') ?? undefined
    const result = await pairServer({ url, pairToken: request.code, serverLabel: request.label, reportedName: health.name, deviceLabel: `${this.selfName()} (Solus host)`, replacesSessionToken: replaced, fetchImpl: fetchPair })
      .catch(() => { throw new Error('The host refused the pairing code or did not answer. Get a fresh code with solus pair and try again.') })
    if (result.installationId !== installationId) throw new Error('A different host answered the pairing request. Nothing was saved.')
    if (!result.server.identityKey && url.startsWith('http:')) throw new Error('This host is too old to prove its identity over HTTP. Update it or use HTTPS.')
    if (signal?.aborted || this.generations.get(installationId) !== generation || findHostRecord(installationId)?.forgotten && !before?.forgotten) {
      throw new Error('Pairing ended before it could be saved. Pair again if you still want access.')
    }
    const { sessionToken } = result.server
    const listing = listingOf(result.server)
    if (!listing) throw new Error('The pairing reply did not name a remote host.')
    const now = this.now()
    saveHostConnection(listing, { kind: 'pairing', token: sessionToken, settings: { url, pairedAt: now, refreshedAt: now } })
    return findHostRecord(installationId)!.listing
  }

  forget(installationId: string): boolean {
    this.nextGeneration(installationId)
    return removeHostListing(installationId)
  }

  /** A token goes only to the saved host, and a late refresh cannot restore a forgotten connection. */
  async credential(installationId: string): Promise<string | null> {
    const record = findHostRecord(installationId)
    const connection = record?.pairing
    const token = hostCredential(installationId, 'pairing')
    if (!record || !connection || !token) return null
    if (!await answersAsSavedHost(this.fetchImpl, { url: connection.url }, record.listing, AbortSignal.timeout(TIMEOUT_MS))) return null
    if (hostCredential(installationId, 'pairing') !== token) return null
    if (this.now() - connection.refreshedAt < REFRESH_AFTER_MS) return token
    const refreshed = await refreshHostSession(this.fetchImpl, connection.url, token, TIMEOUT_MS)
    if (hostCredential(installationId, 'pairing') !== token) return null
    if (refreshed.result === 'unauthorized') { clearHostCredential(installationId, 'pairing'); return null }
    if (refreshed.result !== 'refreshed') return token
    saveHostConnection(record.listing, { kind: 'pairing', token: refreshed.sessionToken, settings: { ...connection, refreshedAt: this.now() } })
    return refreshed.sessionToken
  }

  /** The client's own pairing uses a fresh code; the persistent host credential never leaves this process. */
  async forClient(installationId: string): Promise<HostClientPairing> {
    const token = await this.credential(installationId)
    const record = findHostRecord(installationId)
    if (!token || !record?.pairing) throw new Error('This host no longer has access to that machine. Pair it again.')
    const url = record.pairing.url
    const dialed = await dialHostSocket(url, { credential: { kind: 'session-token', token } }, { timeoutMs: TIMEOUT_MS })
    if (!dialed.ok) throw new Error('The remote host refused this connection. Pair it again.')
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

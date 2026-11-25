/**
 * The join of the host catalog (plans/033 §4.1), as pure functions: the person's
 * host list, the account directory, and this device's credentials, joined by host
 * id into the hosts a client knows. `host-catalog.ts` keeps the answers and calls
 * `joinHosts` after each change; nothing here reads or writes storage.
 */

import type { HostListing } from '@solus/contracts/host-list'
import type { HostOperatingSystem } from '@solus/contracts/types'
import type { DirectoryHost } from '@solus/contracts/uplink'
import { dialableRoutes, listedRoutes, mergeRoutes, type HostRoute, type RouteSource } from '@solus/contracts/host-routes'
import { deviceRoutes, isDeviceRoute, type HostCredential } from './host-credentials'
import { LOCAL_SERVER_ID, pairedAddress, type KnownHost, type KnownHostUplink } from './known-host'
import type { KnownWorkspace } from './workspace-registry'
import type { AnswerState } from './host-catalog'
import { urlHost } from './pairing'

/** One directory answer. */
export interface DirectoryAnswer {
  directoryUrl: string
  hosts: readonly DirectoryHost[]
  workspaces: readonly KnownWorkspace[]
}

/** What this client learned about a host while it runs; never written to the device. */
export interface LearnedFacts {
  /** Routes by source, each replacing that source's routes in the join. */
  routes?: Partial<Record<RouteSource, HostRoute[]>>
  identityKey?: string
  os?: HostOperatingSystem
  lastConnected?: number
}

/** The answers the join reads. */
export interface CatalogAnswers {
  /** The list's last answer with this client's unconfirmed writes over it; empty before one. */
  listings: ReadonlyMap<string, HostListing>
  listState: AnswerState
  directory: DirectoryAnswer | null
  credentials: ReadonlyMap<string, HostCredential>
  learned: ReadonlyMap<string, LearnedFacts>
  /** The host that served this web page: shown from its credential, as no list names it. */
  deviceHostId?: string | null
}

/** What the registry keeps of a directory row beyond its routes. */
function uplinkOf(host: DirectoryHost, directoryUrl: string): KnownHostUplink {
  const uplink: KnownHostUplink = { hostId: host.hostId, directoryUrl, kind: host.kind }
  if (host.organizationIds.length > 0) uplink.organizationIds = [...host.organizationIds]
  if (host.ownerName) uplink.ownerName = host.ownerName
  if (host.ownerUserId) uplink.ownerUserId = host.ownerUserId
  if (host.hasManagedCompute) uplink.hasManagedCompute = true
  if (host.managedState) uplink.managedState = host.managedState
  return uplink
}

/**
 * Whether this page can reach a host the directory lists. A registered host that is
 * not linked is listed with no route, and a client reaches it only on a network it
 * shares with the host. An `https:` page cannot dial an `http:` address (mixed
 * content), so there such a host is shown only when this client knows an `https:`
 * route to it. A cloud machine with managed compute is always shown: it has no route
 * while it is stopped, and the page can start it.
 */
function isListingReachable(host: DirectoryHost, routes: readonly HostRoute[], clientOrigin: string): boolean {
  return host.hasManagedCompute === true || !clientOrigin.startsWith('https:') || dialableRoutes(routes, clientOrigin).length > 0
}

/** The routes after `learned` replaced each source it holds. */
function withLearnedRoutes(routes: readonly HostRoute[], learned: LearnedFacts | undefined): HostRoute[] {
  const sources = learned?.routes
  if (!sources) return [...routes]
  const replaced = new Set(Object.keys(sources))
  // SAFETY: the keys of `LearnedFacts.routes` are route sources.
  const added = (Object.keys(sources) as RouteSource[]).flatMap((source) => sources[source] ?? [])
  return [...routes.filter((route) => !replaced.has(route.source ?? 'pairing')), ...added]
}

/** What each answer says about one host. */
interface HostAnswers {
  base: KnownHost
  listed: DirectoryHost | undefined
  credential: HostCredential | undefined
  learned: LearnedFacts | undefined
}

/** A host's routes from every answer; null when only the directory names it and this page cannot reach it. */
function joinedRoutes({ base, listed, credential, learned }: HostAnswers, now: number, clientOrigin: string): HostRoute[] | null {
  // The device's routes come from its credential; the list's copy of them is another device's.
  const own = credential ? [...credential.routes, ...base.routes.filter((route) => !isDeviceRoute(route))] : base.routes
  const routes = withLearnedRoutes(own, learned)
  if (!listed) return routes
  // The directory's routes replace its earlier ones. Routes from the host, a pairing,
  // or this client's network stay: `chooseRoute` asks each one, so a stale address
  // costs one parallel check and never wins.
  const merged = mergeRoutes(routes, listed.routes, 'directory', now)
  return credential?.token || isListingReachable(listed, merged, clientOrigin) ? merged : null
}

/** What this device's credential gives a host. */
function credentialFacts(credential: HostCredential | undefined): Pick<KnownHost, 'sessionToken' | 'routeOrder' | 'tokenPairedOverHttps' | 'identityKey' | 'ownerPairedAt'> {
  if (!credential) return { sessionToken: '' }
  const facts: Pick<KnownHost, 'sessionToken' | 'routeOrder' | 'tokenPairedOverHttps' | 'identityKey' | 'ownerPairedAt'> = { sessionToken: credential.token }
  if (credential.routeOrder) facts.routeOrder = credential.routeOrder
  if (credential.tokenPairedOverHttps) facts.tokenPairedOverHttps = true
  if (credential.identityKey) facts.identityKey = credential.identityKey
  if (credential.ownerPairedAt !== undefined) facts.ownerPairedAt = credential.ownerPairedAt
  return facts
}

function joinedHost(answers: HostAnswers, routes: HostRoute[], directoryUrl: string): KnownHost {
  const { base, listed, learned } = answers
  const { identityKey: pairedKey, ...credential } = credentialFacts(answers.credential)
  const host: KnownHost = {
    id: base.id,
    // A cloud machine's name is the one members give it on the account site, so a
    // rename there reaches every client. A name typed here still wins (`hasUserLabel`).
    label: listed?.kind === 'cloud' ? listed.label : base.label,
    installationId: base.installationId,
    lastConnected: Math.max(base.lastConnected, learned?.lastConnected ?? 0),
    routes,
    ...credential,
  }
  if (base.hasUserLabel) host.hasUserLabel = true
  const os = learned?.os ?? base.os ?? listed?.os
  if (os) host.os = os
  const identityKey = pairedKey ?? learned?.identityKey ?? base.identityKey
  if (identityKey) host.identityKey = identityKey
  if (listed) host.uplink = uplinkOf(listed, directoryUrl)
  return host
}

/**
 * The hosts a client knows, joined by id (plans/033 §4.1):
 *
 * - each listed host, with this device's token and its own routes when it holds a credential;
 * - each directory host, merged with its listing by installation id; one only listed
 *   there that this page cannot reach is left out (`isListingReachable`);
 * - a host this device holds a credential for that no answer names shows only while
 *   the list read failed, so a client with no network still reaches the hosts it paired.
 *   While the list loads it waits, so boot dials the listed hosts after the read;
 * - the device host shows from its credential at all times: it is not on its own list.
 */
export function joinHosts(answers: CatalogAnswers, now: number, clientOrigin: string): KnownHost[] {
  const directoryUrl = answers.directory?.directoryUrl ?? ''
  const byInstallation = new Map((answers.directory?.hosts ?? []).map((host) => [host.installationId, host]))
  const joined: KnownHost[] = []
  const seen = new Set<string>()
  const add = (base: KnownHost, listed: DirectoryHost | undefined): void => {
    seen.add(base.id)
    const hostAnswers: HostAnswers = { base, listed, credential: answers.credentials.get(base.id), learned: answers.learned.get(base.id) }
    const routes = joinedRoutes(hostAnswers, now, clientOrigin)
    if (routes) joined.push(joinedHost(hostAnswers, routes, directoryUrl))
  }
  for (const listing of answers.listings.values()) {
    const listed = byInstallation.get(listing.installationId)
    byInstallation.delete(listing.installationId)
    add(hostOfListing(listing), listed)
  }
  for (const listed of byInstallation.values()) {
    if (seen.has(listed.installationId)) continue
    add({ id: listed.installationId, label: listed.label, sessionToken: '', installationId: listed.installationId, lastConnected: 0, routes: [], os: listed.os }, listed)
  }
  for (const [id, credential] of answers.credentials) {
    if (seen.has(id) || id === LOCAL_SERVER_ID) continue
    if (answers.listState !== 'failed' && id !== answers.deviceHostId) continue
    const address = pairedAddress(credential)
    add({ id, label: address ? urlHost(address) : id, sessionToken: '', installationId: id, lastConnected: 0, routes: [] }, undefined)
  }
  return joined
}

function hostOfListing(listing: HostListing): KnownHost {
  const host: KnownHost = { id: listing.id, label: listing.label, sessionToken: '', installationId: listing.installationId, lastConnected: listing.lastConnected, routes: listing.routes }
  if (listing.hasUserLabel) host.hasUserLabel = true
  if (listing.os) host.os = listing.os
  if (listing.identityKey) host.identityKey = listing.identityKey
  return host
}

/**
 * The listing of a host this client connected to itself: paired, added over SSH,
 * or forwarded, so it holds a token. The local host and a cloud machine are not on
 * the list. The listing never carries the token.
 */
export function listingOf(host: KnownHost): HostListing | null {
  if (host.id === LOCAL_SERVER_ID || host.uplink?.kind === 'cloud' || !host.sessionToken) return null
  const listing: HostListing = { id: host.id, label: host.label, installationId: host.installationId, routes: listedRoutes(host.routes), lastConnected: host.lastConnected }
  if (host.hasUserLabel) listing.hasUserLabel = true
  if (host.os) listing.os = host.os
  if (host.identityKey) listing.identityKey = host.identityKey
  return listing
}

/** The credential a host this client paired gives the device. */
export function credentialOf(host: KnownHost): HostCredential {
  const credential: HostCredential = { token: host.sessionToken, routes: deviceRoutes(host.routes) }
  if (host.identityKey) credential.identityKey = host.identityKey
  if (host.tokenPairedOverHttps) credential.tokenPairedOverHttps = true
  if (host.routeOrder) credential.routeOrder = host.routeOrder
  if (host.ownerPairedAt !== undefined) credential.ownerPairedAt = host.ownerPairedAt
  return credential
}

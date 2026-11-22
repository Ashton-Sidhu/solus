import { z } from 'zod'
import { mergeRoutes } from '@solus/contracts/host-routes'
import { HOST_LIST_MAX_ENTRIES, hostListingSchema, type HostListing } from '@solus/contracts/host-list'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { getDb } from '../db'
import { dataDir } from '../platform/paths'
import { secretStore } from '../platform/secrets'
import { createLogger } from '../logger'

const log = createLogger('main', 'host-list')

/** One host record owns its listing and all host-to-host connection settings.
 * Credentials are keyed by this record in secure storage, never in the listing.
 * A forgotten record is a tombstone: a stale introduction cannot restore access.
 * Old independent SSH and introduction stores are deliberately not loaded. */
const forwardSchema = z.object({
  sshTarget: z.string().min(1), identityFile: z.string().optional(),
  remotePort: z.number().int().positive(), localPort: z.number().int().positive().optional(),
  startedBySolus: z.boolean(), isLinked: z.boolean(),
})
const introductionSchema = z.object({
  url: z.string().min(1), introducedAt: z.number(), refreshedAt: z.number(), grantedDeviceId: z.string().min(1),
})
const pairingSchema = z.object({ url: z.string().min(1), pairedAt: z.number(), refreshedAt: z.number() })
const recordSchema = z.object({
  listing: hostListingSchema,
  forward: forwardSchema.optional(), introduction: introductionSchema.optional(), pairing: pairingSchema.optional(),
  forgotten: z.boolean().default(false),
})
export type HostRecord = z.infer<typeof recordSchema>
export type HostForward = z.infer<typeof forwardSchema>
export type HostIntroductionConnection = z.infer<typeof introductionSchema>
const credentialsSchema = z.object({ forward: z.string().min(1).optional(), introduction: z.string().min(1).optional(), pairing: z.string().min(1).optional() })
type HostCredentials = z.infer<typeof credentialsSchema>
const changedListeners = new Set<() => void>()
export function onHostRecordsChanged(listener: () => void): () => void {
  changedListeners.add(listener)
  return () => { changedListeners.delete(listener) }
}

const removedListeners = new Set<(record: HostRecord) => void>()

export function onHostRecordRemoved(listener: (record: HostRecord) => void): () => void {
  removedListeners.add(listener)
  return () => { removedListeners.delete(listener) }
}

export function readHostRecords(): HostRecord[] {
  const rows = z.array(z.object({ id: z.string(), listing: z.string() })).parse(getDb().prepare('SELECT id, listing FROM host_list ORDER BY last_connected DESC, id').all())
  return rows.flatMap((row) => {
    try {
      const parsed = recordSchema.safeParse(JSON.parse(row.listing))
      if (parsed.success) return [parsed.data]
    } catch { /* An unreadable record cannot grant access. */ }
    log.warn('host_record_unreadable', { hostId: row.id })
    return []
  })
}

export function findHostRecord(id: string): HostRecord | undefined {
  const row = getDb().prepare('SELECT listing FROM host_list WHERE id = ?').get(id)
  if (!row) return undefined
  const { listing } = z.object({ listing: z.string() }).parse(row)
  try { return recordSchema.safeParse(JSON.parse(listing)).data } catch { return undefined }
}

/** The client-safe catalog. Runtime settings and credentials never cross this interface. */
export function readHostList(): HostListing[] {
  return readHostRecords().filter((record) => !record.forgotten).map((record) => record.listing)
}

function credentialLocation(installationId: string) {
  const key = `host-connection-${createHash('sha256').update(installationId).digest('hex')}`
  return { key, path: join(dataDir(), `${key}.bin`) }
}

export function hostCredential(installationId: string, kind: keyof HostCredentials): string | null {
  const record = findHostRecord(installationId)
  if (!record || record.forgotten || !record[kind]) return null
  const { key, path } = credentialLocation(installationId)
  return secretStore().loadJson(key, path, credentialsSchema)?.[kind] ?? null
}

export function saveHostRecord(record: HostRecord): void {
  record = recordSchema.parse(record)
  const db = getDb()
  const old = findHostRecord(record.listing.installationId)
  if (!record.forgotten && (!old || old.forgotten)) {
    const { count } = z.object({ count: z.number() }).parse(db.prepare("SELECT COUNT(*) AS count FROM host_list WHERE json_valid(listing) AND json_extract(listing, '$.forgotten') = 0").get())
    if (count >= HOST_LIST_MAX_ENTRIES) throw new HostListFullError()
  }
  db.prepare(`INSERT INTO host_list (id, listing, last_connected) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET listing = excluded.listing, last_connected = excluded.last_connected`)
    .run(record.listing.installationId, JSON.stringify(record), record.listing.lastConnected)
  for (const listener of changedListeners) listener()
}

/** Only an explicit add may restore a forgotten record. Updating a channel cannot. */
export function saveHostConnection(
  listing: HostListing,
  connection: { kind: 'forward'; settings: HostForward; token: string } | { kind: 'introduction'; settings: HostIntroductionConnection; token: string } | { kind: 'pairing'; settings: z.infer<typeof pairingSchema>; token: string },
): void {
  const old = findHostRecord(listing.installationId)
  if (old?.forgotten && connection.kind === 'introduction') throw new Error(`${listing.label} was forgotten on this host.`)
  const { key, path } = credentialLocation(listing.installationId)
  const credentials = secretStore().loadJson(key, path, credentialsSchema) ?? {}
  credentials[connection.kind] = connection.token
  secretStore().saveJson(key, path, credentials)
  const record: HostRecord = old ?? { listing, forgotten: false }
  const userLabel = old?.listing.hasUserLabel ? old.listing.label : null
  record.listing = { ...old?.listing, ...listing,
    routes: mergeRoutes(old?.listing.routes ?? [], listing.routes, connection.kind === 'forward' ? 'ssh' : 'host', Date.now()) }
  if (!listing.os && old?.listing.os) record.listing.os = old.listing.os
  if (userLabel !== null) {
    record.listing.label = userLabel
    record.listing.hasUserLabel = true
  }
  record.forgotten = false
  if (connection.kind === 'forward') record.forward = connection.settings
  else if (connection.kind === 'introduction') record.introduction = connection.settings
  else record.pairing = connection.settings
  saveHostRecord(record)
}

/** Remove a connection without deleting another way to reach this same host. */
export function removeHostConnection(installationId: string, kind: keyof HostCredentials): void {
  const record = findHostRecord(installationId)
  if (!record) return
  delete record[kind]
  saveHostRecord(record)
  clearHostCredential(installationId, kind)
}

/** Keep the known machine when its access expires, so a host listing can ask for a new pairing. */
export function clearHostCredential(installationId: string, kind: keyof HostCredentials): void {
  const { key, path } = credentialLocation(installationId)
  const credentials = secretStore().loadJson(key, path, credentialsSchema) ?? {}
  delete credentials[kind]
  secretStore().saveJson(key, path, credentials)
}

export class HostListFullError extends Error {
  constructor() {
    super(`The host list holds at most ${HOST_LIST_MAX_ENTRIES} hosts. Remove one first.`)
  }
}

/** A client refresh changes only the listing; connection settings stay with the record. */
export function putHostListing(listing: HostListing): void {
  const record = findHostRecord(listing.installationId)
  saveHostRecord({ ...record, listing, forgotten: false })
}

/** Forget is one operation for every channel. Listeners release only captured resources. */
export function removeHostListing(id: string): boolean {
  const record = findHostRecord(id)
  if (!record) {
    saveHostRecord({ listing: { id, installationId: id, label: id, routes: [], lastConnected: 0 }, forgotten: true })
    return false
  }
  if (record.forgotten) return false
  const { key, path } = credentialLocation(record.listing.installationId)
  secretStore().remove(key, path)
  saveHostRecord({ listing: record.listing, forgotten: true })
  for (const listener of removedListeners) listener(record)
  return true
}

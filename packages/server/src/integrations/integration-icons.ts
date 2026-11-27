import type { Icon } from '@modelcontextprotocol/client'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { integrationIconSchema, type IntegrationIcon } from '@solus/contracts/integration-types'
import { firstRow, runSql } from '../db/sql'
import { createLogger } from '../logger'

const log = createLogger('integrations', 'integration-icons.ts')

/** An icon bigger than this is not kept: a logo is a few kilobytes. */
export const ICON_MAX_BYTES = 64 * 1024
const FETCH_TIMEOUT_MS = 5_000
/** A server's icon is read again after a week, so a new logo at the same address shows. */
const REFETCH_AFTER_MS = 7 * 24 * 60 * 60 * 1000
const IMAGE_TYPES = new Set(['image/png', 'image/svg+xml', 'image/jpeg', 'image/webp', 'image/gif'])

/** The icons to fetch for a light and a dark background: a scalable one first, else the largest. */
export function chooseIcons(icons: readonly Icon[]): { light: Icon | null; dark: Icon | null } {
  const usable = icons.filter((icon) => icon.src.startsWith('https://') || /^data:image\//i.test(icon.src))
  const best = (candidates: Icon[]) => candidates.sort((a, b) => rank(b) - rank(a))[0] ?? null
  return {
    light: best(usable.filter((icon) => icon.theme !== 'dark')),
    dark: best(usable.filter((icon) => icon.theme === 'dark')),
  }
}

function rank(icon: Icon): number {
  if (icon.mimeType === 'image/svg+xml' || icon.src.startsWith('data:image/svg+xml') || /\.svg(\?|$)/i.test(icon.src)) return Number.MAX_SAFE_INTEGER
  return Math.max(0, ...(icon.sizes ?? []).map((size) => (size === 'any' ? Number.MAX_SAFE_INTEGER - 1 : Number.parseInt(size, 10) || 0)))
}

/**
 * One icon as a `data:` URI, or null when it is not a small image. The host
 * fetches an `https:` address with no credentials and no redirect, and checks
 * the type and the size; an `http:` or other address is never fetched.
 */
export async function iconDataUri(icon: Icon, fetchImpl: typeof fetch): Promise<string | null> {
  if (icon.src.startsWith('data:')) {
    const type = /^data:([^;,]+)/.exec(icon.src)?.[1]?.toLowerCase()
    return type && IMAGE_TYPES.has(type) && icon.src.length <= ICON_MAX_BYTES * 1.4 ? icon.src : null
  }
  if (!icon.src.startsWith('https://')) return null
  const response = await fetchImpl(icon.src, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? ''
  if (!response.ok || !IMAGE_TYPES.has(type) || Number(response.headers.get('content-length') ?? 0) > ICON_MAX_BYTES) {
    await response.body?.cancel()
    return null
  }
  const bytes = await readAtMost(response, ICON_MAX_BYTES)
  return bytes ? `data:${type};base64,${Buffer.from(bytes).toString('base64')}` : null
}

/** The body, or null when it is longer than `limit`: a missing or false length header does not let a big body through. */
async function readAtMost(response: Response, limit: number): Promise<Uint8Array | null> {
  const reader = response.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

const rowSchema = z.object({ icon: z.string(), source_key: z.string(), fetched_at: z.number() })

/**
 * The icons that integrations' servers name in their `serverInfo`, in the host
 * table `integration_icon`. The gateway asks for a refresh after each tool
 * list; the fetch runs apart from the list, once per integration at a time,
 * and a changed icon tells the listeners, so the clients read the record again.
 * A fetch that fails keeps the icon the host had.
 */
export class IntegrationIcons {
  private readonly refreshing = new Map<string, Promise<void>>()
  private readonly listeners: Array<(integrationId: string) => void> = []

  constructor(private readonly fetchImpl: typeof fetch = fetch, private readonly now: () => number = Date.now) {}

  get(integrationId: string): IntegrationIcon | null {
    const row = this.row(integrationId)
    if (!row) return null
    const parsed = integrationIconSchema.safeParse(JSON.parse(row.icon))
    return parsed.success ? parsed.data : null
  }

  /** Reads the server's icons again when they changed or the saved ones are old. Never throws. */
  refresh(integrationId: string, icons: readonly Icon[] | undefined): Promise<void> {
    const running = this.refreshing.get(integrationId)
    if (running) return running
    const job = this.fetchAndSave(integrationId, icons ?? [])
      .catch((error: unknown) => { log.info('integration_icon_fetch_failed', { integrationId, error: error instanceof Error ? error.message : String(error) }) })
      .finally(() => { this.refreshing.delete(integrationId) })
    this.refreshing.set(integrationId, job)
    return job
  }

  onChanged(listener: (integrationId: string) => void): void {
    this.listeners.push(listener)
  }

  /** A removal, or a new command: the old server's icon goes with it. The caller's own change event tells the clients. */
  remove(integrationId: string): boolean {
    return runSql(sql`DELETE FROM integration_icon WHERE integration_id = ${integrationId}`) > 0
  }

  private async fetchAndSave(integrationId: string, icons: readonly Icon[]): Promise<void> {
    const chosen = chooseIcons(icons)
    const sourceKey = JSON.stringify([chosen.light?.src ?? null, chosen.dark?.src ?? null])
    const saved = this.row(integrationId)
    // A dark icon alone is often white: on a light background it would not show, so the tile keeps its fallback.
    if (!chosen.light) {
      if (saved && this.remove(integrationId)) this.changed(integrationId)
      return
    }
    if (saved?.source_key === sourceKey && this.now() - saved.fetched_at < REFETCH_AFTER_MS) return
    const [light, dark] = await Promise.all([iconDataUri(chosen.light, this.fetchImpl), chosen.dark ? iconDataUri(chosen.dark, this.fetchImpl) : null])
    if (!light) return
    const icon: IntegrationIcon = dark ? { light, dark } : { light }
    const text = JSON.stringify(icon)
    runSql(sql`
      INSERT INTO integration_icon (integration_id, icon, source_key, fetched_at) VALUES (${integrationId}, ${text}, ${sourceKey}, ${this.now()})
      ON CONFLICT (integration_id) DO UPDATE SET icon = ${text}, source_key = ${sourceKey}, fetched_at = ${this.now()}
    `)
    log.info('integration_icon_saved', { integrationId, bytes: text.length, hasDark: !!icon.dark })
    if (saved?.icon !== text) this.changed(integrationId)
  }

  private row(integrationId: string): z.infer<typeof rowSchema> | null {
    return firstRow(sql`SELECT icon, source_key, fetched_at FROM integration_icon WHERE integration_id = ${integrationId}`, rowSchema)
  }

  private changed(integrationId: string): void {
    for (const listener of this.listeners) listener(integrationId)
  }
}

/** The host's one cache of server icons: the gateway fills it, and the integration answers read it. */
export const integrationIcons = new IntegrationIcons()

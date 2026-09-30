import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { z } from 'zod'
import {
  BUNDLED_MODEL_PROFILES,
  modelProfilesSchema,
  replaceModelProfiles,
  type ModelProfiles,
  type ModelProfilesStatus,
} from '@solus/contracts/types'
import { createLogger } from '../logger'
import { nextDailyRunAt, previousDailyRunAt } from './daily-schedule'

const log = createLogger('model-profiles', 'model-profiles-service.ts')

/** The file on `main` is the published list: merging a change to it releases a model. */
export const MODEL_PROFILES_URL = 'https://raw.githubusercontent.com/Ashton-Sidhu/solus/main/packages/contracts/src/model-profiles.json'
/** The host asks GitHub once a day, at 15:00 in New York. */
export const MODEL_PROFILES_CHECK_HOUR = 15
export const MODEL_PROFILES_CHECK_TIME_ZONE = 'America/New_York'
/** A laptop that sleeps through 15:00 checks within this long of waking. */
const MAX_TIMER_MS = 60 * 60_000

/** Downloads the published list. A list this build cannot read is refused: a
 *  newer Solus may publish a field or effort level this one does not know. */
export async function downloadModelProfiles(): Promise<ModelProfiles> {
  const url = process.env.SOLUS_MODEL_PROFILES_URL || MODEL_PROFILES_URL
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status} for the model list.`)
  const parsed = modelProfilesSchema.safeParse(await response.json())
  if (!parsed.success) throw new Error(UNREADABLE_LIST)
  return parsed.data
}

export const UNREADABLE_LIST = 'The published model list does not match this version of Solus. Update Solus to read it.'

const cachedModelProfilesSchema = z.object({ fetchedAt: z.number(), profiles: modelProfilesSchema })
type CachedModelProfiles = z.infer<typeof cachedModelProfilesSchema>

interface ModelProfilesServiceDeps {
  /** Where the last published list is kept, so a restart without a network keeps it. */
  cachePath: string
  download(): Promise<ModelProfiles>
  publish(status: ModelProfilesStatus): void
  now?: () => number
}

/**
 * The host's model list (`docs/model-profiles.md`). It starts on the list its
 * build shipped with, puts the cached published list in effect at boot, and
 * replaces it with the one on GitHub each day. A list this build cannot read is
 * refused and the list in effect stays.
 */
export class ModelProfilesService {
  status: ModelProfilesStatus = bundledStatus(null)
  private readonly now: () => number
  private pending: Promise<ModelProfilesStatus> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false

  constructor(private readonly deps: ModelProfilesServiceDeps) {
    this.now = deps.now ?? Date.now
  }

  /** Synchronous up to the network: the cached list is in effect before the host serves a turn. */
  start(): void {
    this.stopped = false
    const cached = this.readCache()
    if (cached) {
      replaceModelProfiles(cached.profiles)
      this.status = { ...this.status, source: 'remote', fetchedAt: cached.fetchedAt, profiles: cached.profiles }
    }
    this.tick()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** Downloads the published list now. */
  check(): Promise<ModelProfilesStatus> {
    return this.run(false)
  }

  /**
   * Drops the cached list and downloads the published one. When the download
   * fails the host goes back to the list its build shipped with: the cache is
   * gone either way, which is what clearing it means.
   */
  refresh(): Promise<ModelProfilesStatus> {
    return this.run(true)
  }

  private run(clearCache: boolean): Promise<ModelProfilesStatus> {
    if (this.pending) return this.pending
    this.update({ checking: true })
    this.pending = (async () => {
      try {
        const profiles = await this.deps.download()
        const fetchedAt = this.now()
        this.writeCache({ fetchedAt, profiles })
        replaceModelProfiles(profiles)
        log.info('model_profiles_updated', { models: Object.values(profiles).reduce((count, models) => count + Object.keys(models ?? {}).length, 0) })
        this.update({ source: 'remote', fetchedAt, checkedAt: fetchedAt, checking: false, error: null, profiles })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log.warn('model_profiles_check_failed', { error: message, clearCache })
        if (clearCache) {
          this.removeCache()
          replaceModelProfiles(BUNDLED_MODEL_PROFILES)
          this.update({ ...bundledStatus(this.now()), error: message })
        } else {
          this.update({ checkedAt: this.now(), checking: false, error: message })
        }
      }
      return this.status
    })().finally(() => { this.pending = null })
    return this.pending
  }

  /** Checks when the last 15:00 has passed since the host last asked, then sleeps until the next one. */
  private tick(): void {
    if (this.stopped) return
    const now = this.now()
    const lastAsked = this.status.checkedAt ?? this.status.fetchedAt ?? -Infinity
    if (lastAsked < previousDailyRunAt(now, MODEL_PROFILES_CHECK_HOUR, MODEL_PROFILES_CHECK_TIME_ZONE)) void this.check()
    const next = nextDailyRunAt(now, MODEL_PROFILES_CHECK_HOUR, MODEL_PROFILES_CHECK_TIME_ZONE)
    this.timer = setTimeout(() => this.tick(), Math.min(next - now, MAX_TIMER_MS))
    this.timer.unref?.()
  }

  private update(patch: Partial<ModelProfilesStatus>): void {
    this.status = { ...this.status, ...patch }
    if (!this.stopped) this.deps.publish(this.status)
  }

  private readCache(): CachedModelProfiles | null {
    let raw: string
    try { raw = readFileSync(this.deps.cachePath, 'utf8') } catch { return null }
    try {
      const cached = cachedModelProfilesSchema.safeParse(JSON.parse(raw))
      if (cached.success) return cached.data
    } catch {}
    // A cache written by a newer Solus, or a damaged one: the bundled list is safer.
    log.warn('model_profiles_cache_ignored', { cachePath: this.deps.cachePath })
    return null
  }

  private writeCache(cached: CachedModelProfiles): void {
    mkdirSync(dirname(this.deps.cachePath), { recursive: true })
    writeFileSync(this.deps.cachePath, JSON.stringify(cached))
  }

  private removeCache(): void {
    rmSync(this.deps.cachePath, { force: true })
  }
}

function bundledStatus(checkedAt: number | null): ModelProfilesStatus {
  return { source: 'bundled', fetchedAt: null, checkedAt, checking: false, error: null, profiles: BUNDLED_MODEL_PROFILES }
}

import {
  FIVE_HOUR_WINDOW_MINS,
  WEEKLY_WINDOW_MINS,
  type AgentId,
  type AgentUsageLimits,
  type UsageWindow,
} from '@solus/contracts/types'

const SECOND = 1_000
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export type UsageDisplayMode = 'remaining' | 'used'
export type UsagePace = 'ahead' | 'on' | 'under'
export type UsageTone = 'ok' | 'low' | 'spent'
export type UsageWindowKind = 'session' | 'weekly' | 'monthly'
export type UsageStateFilter = 'all' | 'issues' | 'ahead' | 'blocked' | 'signed_out'

export interface UsageFilterCriteria {
  readonly providers?: ReadonlySet<AgentId>
  readonly state?: UsageStateFilter
}

export interface UsageModelGroupSection {
  readonly groupId: string | null
  readonly groupLabel: string | null
  readonly windows: readonly UsagePoolWindow[]
}

export interface UsagePooledChartSegment {
  readonly key: string
  readonly index: number
  readonly member: UsagePoolMember
  readonly start: number
  readonly end: number
  readonly width: number
  readonly fillEnd: number
  readonly refillStart: number
  readonly refillEnd: number
  readonly paceX: number | null
  readonly restoresPoolPercent: number
}

export interface HostUsageInput {
  readonly serverId: string
  readonly label: string
  readonly connected: boolean
  readonly state: 'loading' | 'ready' | 'error'
  readonly error?: string
  readonly snapshots: readonly AgentUsageLimits[]
  /** Enabled, available agents reported by this host (`StartInfo.agents`). */
  readonly availableProviders?: readonly AgentId[]
}

export interface UsageWindowView {
  readonly id: string
  readonly kind: UsageWindowKind
  readonly label: string
  readonly groupId?: string
  readonly groupLabel?: string
  readonly usedPercent: number
  readonly remainingPercent: number
  readonly tone: UsageTone
  readonly resetsAt: number | null
  readonly resetsLabel: string | null
  readonly resetCountdown: string | null
  readonly resetCompact: string | null
  readonly paceRemainingPercent: number | null
  readonly paceUsedPercent: number | null
  readonly pace: UsagePace | null
  readonly suppressedByWeekly: boolean
  readonly refillPercent: number
}

export interface UsageAccountHost {
  readonly serverId: string
  readonly label: string
}

export type UsageAccountStatus = 'subscription' | 'api' | 'signed_out' | 'unavailable' | 'unsupported'

export interface UsageAccountEntry {
  readonly key: string
  readonly provider: AgentId
  readonly providerLabel: string
  readonly instanceId: string
  readonly displayName: string
  readonly email: string | null
  readonly planType: string | null
  readonly hosts: readonly UsageAccountHost[]
  readonly windows: readonly UsageWindowView[]
  readonly status: UsageAccountStatus
  readonly stale: boolean
  readonly fetchedAt: number
}

export interface UsagePoolMember {
  readonly account: UsageAccountEntry
  readonly window: UsageWindowView
  readonly weight: number
}

export interface UsageNextRefill {
  readonly at: number
  readonly restoresPercent: number
  readonly countdown: string
  readonly accountKey: string
}

export interface UsagePoolWindow {
  readonly id: string
  readonly kind: UsageWindowKind
  readonly label: string
  readonly groupId?: string
  readonly groupLabel?: string
  readonly remainingPercent: number
  readonly usedPercent: number
  readonly tone: UsageTone
  readonly pace: UsagePace | null
  readonly paceRemainingPercent: number | null
  readonly paceUsedPercent: number | null
  readonly members: readonly UsagePoolMember[]
  readonly nextRefill: UsageNextRefill | null
}

export interface UsageProviderGroup {
  readonly provider: AgentId
  readonly label: string
  readonly accounts: readonly UsageAccountEntry[]
  readonly windows: readonly UsagePoolWindow[]
  readonly nonMeteredAccounts: readonly UsageAccountEntry[]
}

export interface UsageFailedHost {
  readonly serverId: string
  readonly label: string
  readonly message: string
}

export interface UsageOverview {
  readonly providers: readonly UsageProviderGroup[]
  readonly loadingHosts: readonly string[]
  readonly failedHosts: readonly UsageFailedHost[]
  readonly staleHosts: readonly string[]
}

const PROVIDER_ORDER: readonly string[] = ['claude-code', 'codex', 'antigravity']

/** Available harnesses whose quota Solus cannot read directly; shown with an
 *  unavailable placeholder on Settings → Usage when the host has no snapshot. */
const UNSUPPORTED_USAGE_PROVIDERS: ReadonlySet<AgentId> = new Set(['antigravity'])

export function usageProviderLabel(provider: AgentId): string {
  switch (provider) {
    case 'claude-code': return 'Claude Code'
    case 'codex': return 'Codex'
    case 'antigravity': return 'Google Antigravity'
    default: return provider
  }
}

export function usageUnsupportedMessage(provider: AgentId): string {
  if (provider === 'antigravity') {
    return 'Usage limits are unavailable in Solus. Check Antigravity to view your quota.'
  }
  return 'Usage limits are unavailable in Solus.'
}

export function unsupportedAccountOf(group: UsageProviderGroup): UsageAccountEntry | null {
  return group.nonMeteredAccounts.find((account) => account.status === 'unsupported') ?? null
}

export function hasUsageSectionContent(group: UsageProviderGroup): boolean {
  return group.windows.length > 0 || unsupportedAccountOf(group) !== null
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const CLAUDE_DATE_LABEL = /^([A-Za-z]{3})\w* (\d{1,2}),? (?:at )?(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s+\(([^)]+)\))?/i
const CLAUDE_WEEKDAY_LABEL = /^([A-Za-z]{3})\w* at (\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s+\(([^)]+)\))?$/i

/**
 * Claude prints localized reset text with no year. Parse both date forms
 * ("Jul 31 at 1am", "Aug 12, 9:40am (UTC)") and weekday forms ("Monday at 10am (UTC)").
 */
export function parseUsageResetLabel(label: string, now: number): number | null {
  const dateMatch = label.match(CLAUDE_DATE_LABEL)
  if (dateMatch) return parseDateReset(dateMatch, now)

  const weekdayMatch = label.match(CLAUDE_WEEKDAY_LABEL)
  if (!weekdayMatch) return null
  const weekday = WEEKDAYS.indexOf(weekdayMatch[1]!.slice(0, 3).toLowerCase())
  if (weekday < 0) return null
  const hours = clockHours(weekdayMatch[2]!, weekdayMatch[4]!)
  const minutes = Number(weekdayMatch[3] ?? 0)
  const timezone = weekdayMatch[5]?.toLowerCase()
  if (timezone && timezone !== 'utc') return null

  const current = new Date(now)
  const currentWeekday = timezone === 'utc' ? current.getUTCDay() : current.getDay()
  const daysAhead = (weekday - currentWeekday + 7) % 7
  let reset = timezone === 'utc'
    ? Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate() + daysAhead, hours, minutes)
    : new Date(current.getFullYear(), current.getMonth(), current.getDate() + daysAhead, hours, minutes, 0, 0).getTime()
  if (reset < now) reset += 7 * DAY
  return reset
}

function parseDateReset(match: RegExpMatchArray, now: number): number | null {
  const month = MONTHS.indexOf(match[1]!.slice(0, 3).toLowerCase())
  if (month < 0) return null
  const day = Number(match[2])
  const minutes = Number(match[4] ?? 0)
  const hours = clockHours(match[3]!, match[5]!)
  const timezone = match[6]?.toLowerCase()
  const current = new Date(now)
  const reset = timezone === 'utc'
    ? new Date(Date.UTC(current.getUTCFullYear(), month, day, hours, minutes, 0, 0))
    : new Date(current.getFullYear(), month, day, hours, minutes, 0, 0)
  if (reset.getTime() < now - 180 * DAY) {
    if (timezone === 'utc') reset.setUTCFullYear(current.getUTCFullYear() + 1)
    else reset.setFullYear(current.getFullYear() + 1)
  }
  return reset.getTime()
}

function clockHours(hour: string, meridiem: string): number {
  let hours = Number(hour) % 12
  if (meridiem.toLowerCase() === 'pm') hours += 12
  return hours
}

export function formatDurationCompact(ms: number): string | null {
  if (ms <= 0) return null
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / MINUTE))}m`
  if (ms < DAY) {
    const hours = Math.floor(ms / HOUR)
    const minutes = Math.round((ms % HOUR) / MINUTE)
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`
  }
  const days = Math.floor(ms / DAY)
  const hours = Math.round((ms % DAY) / HOUR)
  return hours === 0 ? `${days}d` : `${days}d ${hours}h`
}

function padTwo(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * Live countdown duration down to the second, zero-padded on trailing units
 * so tabular numerals hold a steady width as they tick.
 */
export function formatLiveDuration(ms: number, compact = false): string | null {
  if (ms <= 0) return null
  const totalSeconds = Math.ceil(ms / SECOND)
  const days = Math.floor(totalSeconds / 86_400)
  const hours = Math.floor((totalSeconds % 86_400) / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60

  if (compact) {
    if (days > 0) return `${days}d ${padTwo(hours)}h`
    if (hours > 0) return `${hours}h ${padTwo(minutes)}m`
    if (minutes > 0) return `${minutes}m ${padTwo(seconds)}s`
    return `${seconds}s`
  }

  if (days > 0) return `${days}d ${padTwo(hours)}h ${padTwo(minutes)}m ${padTwo(seconds)}s`
  if (hours > 0) return `${hours}h ${padTwo(minutes)}m ${padTwo(seconds)}s`
  if (minutes > 0) return `${minutes}m ${padTwo(seconds)}s`
  return `${seconds}s`
}

export function formatLiveResetCountdown(
  resetsAt: number | null,
  resetsLabel: string | null,
  now: number,
  options?: { readonly verb?: string; readonly compact?: boolean },
): string | null {
  const verb = options?.verb ?? 'resets'
  const compact = options?.compact ?? false
  const prefix = verb ? `${verb} ` : ''
  if (resetsAt !== null && Number.isFinite(resetsAt)) {
    const remaining = resetsAt - now
    if (remaining <= 0) return compact ? 'now' : `${prefix}now`
    const duration = formatLiveDuration(remaining, compact)
    if (!duration) return compact ? 'now' : `${prefix}now`
    return compact ? duration : `${prefix}in ${duration}`
  }
  if (resetsLabel) {
    return compact ? resetsLabel : `${prefix}${resetsLabel}`
  }
  return null
}

export function formatResetCountdown(
  resetsAt: number | null,
  resetsLabel: string | null,
  now: number,
): { full: string; compact: string } | null {
  if (resetsAt !== null) {
    const remaining = resetsAt - now
    if (remaining <= 0) {
      return { full: 'resets now', compact: 'now' }
    }
    if (remaining < MINUTE) {
      return { full: 'Resets momentarily', compact: '<1m' }
    }
    const compact = formatDurationCompact(remaining)
    if (!compact) return { full: 'resets now', compact: 'now' }
    return { full: `resets in ${compact}`, compact }
  }
  if (resetsLabel) {
    return { full: `resets ${resetsLabel}`, compact: resetsLabel }
  }
  return null
}

export function formatExactResetTime(resetsAt: number | null): string | null {
  if (resetsAt === null || !Number.isFinite(resetsAt)) return null
  return new Date(resetsAt).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

export function formatCheckedAt(fetchedAt: number): string | null {
  if (!Number.isFinite(fetchedAt) || fetchedAt <= 0) return null
  return new Date(fetchedAt).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function toneForRemaining(remainingPercent: number): UsageTone {
  if (remainingPercent <= 10) return 'spent'
  if (remainingPercent <= 30) return 'low'
  return 'ok'
}

export function paceLabel(pace: UsagePace): string {
  switch (pace) {
    case 'ahead': return 'Ahead of pace'
    case 'on': return 'On pace'
    case 'under': return 'Under pace'
  }
}

export function maskEmail(email: string): string {
  return email.includes('@') ? '••••••@••••••' : email
}

export function emailInitials(email: string): string {
  const [local = '', domain = ''] = email.split('@')
  return `${local[0] ?? ''}${domain[0] ?? ''}`.toUpperCase() || '?'
}

/** Deterministic hue matching T3 Code's account chips across desktop, web, and mobile. */
export function accountHue(seed: string): number {
  let hash = 0
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0
  }
  return Math.abs(hash) % 360
}

export interface FormattedUsagePercent {
  readonly value: number
  readonly formatted: string
  readonly suffix: string
  readonly barPercent: number
}

export function formatUsagePercent(
  remainingPercent: number,
  usedPercent: number,
  mode: UsageDisplayMode,
): FormattedUsagePercent {
  if (mode === 'used') {
    const rounded = Math.round(usedPercent)
    const formatted = usedPercent > 99 && usedPercent < 100 ? '>99' : String(rounded)
    return { value: rounded, formatted, suffix: '% used', barPercent: clampPercent(usedPercent) }
  }
  const rounded = Math.round(remainingPercent)
  const formatted = remainingPercent > 0 && remainingPercent < 1 ? '<1' : String(rounded)
  return { value: rounded, formatted, suffix: '% left', barPercent: clampPercent(remainingPercent) }
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, value))
}

function elapsedShare(resetsAt: number | null, windowDurationMins: number | null, now: number): number | null {
  if (resetsAt === null || windowDurationMins === null || windowDurationMins <= 0) return null
  const length = windowDurationMins * MINUTE
  const remaining = resetsAt - now
  if (remaining > length) return 0
  return Math.max(0, Math.min(1, (length - remaining) / length))
}

function paceFromShares(usedPercent: number, elapsed: number): UsagePace {
  const gap = usedPercent - elapsed * 100
  if (gap > 5) return 'ahead'
  if (gap < -5) return 'under'
  return 'on'
}

function resolveWindowReset(window: UsageWindow, now: number): number | null {
  if (window.resetsAt !== null && Number.isFinite(window.resetsAt)) return window.resetsAt
  if (window.resetsLabel) return parseUsageResetLabel(window.resetsLabel, now)
  return null
}

function durationForKind(kind: UsageWindowKind): number | null {
  if (kind === 'session') return FIVE_HOUR_WINDOW_MINS
  if (kind === 'weekly') return WEEKLY_WINDOW_MINS
  return null
}

interface SuppressedSessionResult {
  usedPercent: number
  resetsAt: number | null
  resetsLabel: string | null
  refillPercent: number
}

function suppressSessionByWeekly(
  usedPercent: number,
  sessionReset: number | null,
  spentWeekly: UsageWindow,
  fetchedAt: number,
  now: number,
): SuppressedSessionResult {
  const weeklyReset = resolveWindowReset(spentWeekly, now)
  const cutoff = Math.max(now, fetchedAt)
  if (weeklyReset !== null && sessionReset !== null && weeklyReset > cutoff && sessionReset > cutoff) {
    if (sessionReset <= weeklyReset) {
      return { usedPercent: 100, resetsAt: weeklyReset, resetsLabel: spentWeekly.resetsLabel, refillPercent: 100 }
    }
    if (usedPercent >= 100) {
      return { usedPercent: 100, resetsAt: sessionReset, resetsLabel: null, refillPercent: 100 }
    }
    return {
      usedPercent: 100,
      resetsAt: weeklyReset,
      resetsLabel: spentWeekly.resetsLabel,
      refillPercent: clampPercent(100 - usedPercent),
    }
  }
  if (weeklyReset !== null && weeklyReset > cutoff) {
    return { usedPercent: 100, resetsAt: weeklyReset, resetsLabel: spentWeekly.resetsLabel, refillPercent: 100 }
  }
  return { usedPercent: 100, resetsAt: null, resetsLabel: null, refillPercent: 0 }
}

function buildWindowView(
  id: string,
  kind: UsageWindowKind,
  label: string,
  window: UsageWindow,
  now: number,
  options?: {
    groupId?: string
    groupLabel?: string
    spentWeekly?: UsageWindow | null
    fetchedAt?: number
  },
): UsageWindowView {
  let usedPercent = clampPercent(window.usedPercent)
  let resetsAt = resolveWindowReset(window, now)
  let resetsLabel = window.resetsLabel
  let durationMins = durationForKind(kind)
  let suppressedByWeekly = false
  let refillPercent = usedPercent

  // Weekly-blocks-session suppression (matching T3 Code): when weekly is 100% used,
  // the session window cannot run even if it still reports remaining quota.
  if (kind === 'session' && options?.spentWeekly && clampPercent(options.spentWeekly.usedPercent) >= 100) {
    const suppressed = suppressSessionByWeekly(usedPercent, resetsAt, options.spentWeekly, options.fetchedAt ?? 0, now)
    usedPercent = suppressed.usedPercent
    resetsAt = suppressed.resetsAt
    resetsLabel = suppressed.resetsLabel
    refillPercent = suppressed.refillPercent
    suppressedByWeekly = true
    durationMins = null
  }

  const remainingPercent = clampPercent(100 - usedPercent)
  const countdown = formatResetCountdown(resetsAt, resetsLabel, now)
  const elapsed = elapsedShare(resetsAt, durationMins, now)
  const paceRemainingPercent = elapsed === null ? null : Math.round((1 - elapsed) * 100)
  const paceUsedPercent = elapsed === null ? null : Math.round(elapsed * 100)
  const pace = elapsed === null ? null : paceFromShares(usedPercent, elapsed)

  const base: UsageWindowView = {
    id,
    kind,
    label,
    usedPercent,
    remainingPercent,
    tone: toneForRemaining(remainingPercent),
    resetsAt,
    resetsLabel,
    resetCountdown: countdown?.full ?? null,
    resetCompact: countdown?.compact ?? null,
    paceRemainingPercent,
    paceUsedPercent,
    pace,
    suppressedByWeekly,
    refillPercent,
  }
  if (options?.groupId) {
    return { ...base, groupId: options.groupId, groupLabel: options.groupLabel }
  }
  return base
}

function buildAccountWindows(snapshot: AgentUsageLimits, now: number): UsageWindowView[] {
  const windows: UsageWindowView[] = []
  if (snapshot.modelGroups?.length) {
    for (const group of snapshot.modelGroups) {
      const spentWeekly = group.weekly && clampPercent(group.weekly.usedPercent) >= 100 ? group.weekly : null
      if (group.fiveHour) {
        windows.push(buildWindowView(`${group.id}:fiveHour`, 'session', 'Session', group.fiveHour, now, {
          groupId: group.id,
          groupLabel: group.label,
          spentWeekly,
          fetchedAt: snapshot.fetchedAt,
        }))
      }
      if (group.weekly) {
        windows.push(buildWindowView(`${group.id}:weekly`, 'weekly', 'Weekly', group.weekly, now, {
          groupId: group.id,
          groupLabel: group.label,
          fetchedAt: snapshot.fetchedAt,
        }))
      }
    }
    return windows
  }
  const spentWeekly = snapshot.weekly && clampPercent(snapshot.weekly.usedPercent) >= 100 ? snapshot.weekly : null
  if (snapshot.fiveHour) {
    windows.push(buildWindowView('fiveHour', 'session', 'Session', snapshot.fiveHour, now, {
      spentWeekly,
      fetchedAt: snapshot.fetchedAt,
    }))
  }
  if (snapshot.weekly) {
    windows.push(buildWindowView('weekly', 'weekly', 'Weekly', snapshot.weekly, now, {
      fetchedAt: snapshot.fetchedAt,
    }))
  }
  // Its own id, so it pools apart from the all-models week.
  if (snapshot.fableWeekly) {
    windows.push(buildWindowView('fableWeekly', 'weekly', 'Fable weekly', snapshot.fableWeekly, now, {
      fetchedAt: snapshot.fetchedAt,
    }))
  }
  if (snapshot.monthly) {
    windows.push(buildWindowView('monthly', 'monthly', 'Monthly', snapshot.monthly, now, {
      fetchedAt: snapshot.fetchedAt,
    }))
  }
  return windows
}

function accountStatus(snapshot: AgentUsageLimits, windows: readonly UsageWindowView[]): UsageAccountEntry['status'] {
  if (snapshot.usageMode === 'api') return 'api'
  if (snapshot.usageMode === 'signed_out') return 'signed_out'
  if (windows.length > 0) return 'subscription'
  return 'unavailable'
}

function normalizeEmail(email: string | null | undefined): string | null {
  const trimmed = email?.trim().toLowerCase()
  return trimmed ? trimmed : null
}

function planCapacity(provider: AgentId, planType: string | null, kind: UsageWindowKind): number | undefined {
  if (!planType) return undefined
  const lower = planType.trim().toLowerCase()
  if (provider === 'codex' && (kind === 'session' || kind === 'weekly')) {
    if (lower.includes('200')) return 20
    if (lower.includes('100') || lower === 'pro') return 5
    if (lower.includes('plus')) return 1
  }
  if (provider === 'claude-code' && kind === 'session') {
    if (lower.includes('ultra')) return 20
    if (lower.includes('max')) return 5
    if (lower.includes('pro')) return 1
  }
  return undefined
}

const WINDOW_KIND_ORDER = {
  session: 0,
  weekly: 1,
  monthly: 2,
} as const satisfies Record<UsageWindowKind, number>

const MODEL_GROUP_ORDER: readonly string[] = ['gemini', '3p']

function modelGroupRank(groupId: string | undefined, seenOrder: Map<string, number>): number {
  const key = groupId ?? ''
  const canonical = MODEL_GROUP_ORDER.indexOf(key)
  if (canonical !== -1) return canonical
  return MODEL_GROUP_ORDER.length + (seenOrder.get(key) ?? Number.MAX_SAFE_INTEGER)
}

function poolProviderWindows(accounts: readonly UsageAccountEntry[], now: number): UsagePoolWindow[] {
  const byWindowId = new Map<string, Array<{ account: UsageAccountEntry; window: UsageWindowView }>>()
  const groupOrder = new Map<string, number>()
  for (const account of accounts) {
    if (account.status !== 'subscription') continue
    for (const window of account.windows) {
      const groupKey = window.groupId ?? ''
      if (!groupOrder.has(groupKey)) groupOrder.set(groupKey, groupOrder.size)
      const list = byWindowId.get(window.id)
      if (list) list.push({ account, window })
      else byWindowId.set(window.id, [{ account, window }])
    }
  }

  const pools: UsagePoolWindow[] = []
  for (const [id, entries] of byWindowId) {
    const first = entries[0]!.window
    const capacities = entries.map((entry) => planCapacity(entry.account.provider, entry.account.planType, first.kind))
    const weights = capacities.every((cap): cap is number => cap !== undefined)
      ? capacities
      : entries.map(() => 1)
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0)
    const members: UsagePoolMember[] = entries.map((entry, index) => ({
      account: entry.account,
      window: entry.window,
      weight: weights[index]!,
    }))

    const usedPercent = members.reduce((sum, member) => sum + member.window.usedPercent * member.weight, 0) / totalWeight
    const remainingPercent = clampPercent(100 - usedPercent)

    // Weighted pace across members that report a reset clock.
    const timed = members.flatMap((member) =>
      member.window.paceUsedPercent === null
        ? []
        : [{ used: member.window.usedPercent, elapsed: member.window.paceUsedPercent / 100, weight: member.weight }],
    )
    const timedWeight = timed.reduce((sum, item) => sum + item.weight, 0)
    const meanElapsed = timedWeight > 0
      ? timed.reduce((sum, item) => sum + item.elapsed * item.weight, 0) / timedWeight
      : null
    const timedUsed = timedWeight > 0
      ? timed.reduce((sum, item) => sum + item.used * item.weight, 0) / timedWeight
      : 0

    const nextRefillEntry = members
      .flatMap((member) => {
        const at = member.window.resetsAt
        if (at === null || at <= now || member.window.refillPercent <= 0) return []
        const restoresPercent = Math.round((member.window.refillPercent * member.weight) / totalWeight)
        if (restoresPercent <= 0) return []
        const countdown = formatResetCountdown(at, member.window.resetsLabel, now)
        if (!countdown) return []
        return [{
          at,
          restoresPercent,
          countdown: countdown.compact === 'now' ? `↻ +${restoresPercent}% now` : `↻ +${restoresPercent}% in ${countdown.compact}`,
          accountKey: member.account.key,
        }]
      })
      .sort((left, right) => left.at - right.at)[0] ?? null

    const basePoolWindow: UsagePoolWindow = {
      id,
      kind: first.kind,
      label: first.label,
      remainingPercent: Math.round(remainingPercent),
      usedPercent: Math.round(usedPercent),
      tone: toneForRemaining(remainingPercent),
      pace: meanElapsed === null ? null : paceFromShares(timedUsed, meanElapsed),
      paceRemainingPercent: meanElapsed === null ? null : Math.round((1 - meanElapsed) * 100),
      paceUsedPercent: meanElapsed === null ? null : Math.round(meanElapsed * 100),
      members,
      nextRefill: nextRefillEntry,
    }
    if (first.groupId) {
      pools.push({ ...basePoolWindow, groupId: first.groupId, groupLabel: first.groupLabel })
    } else {
      pools.push(basePoolWindow)
    }
  }

  return pools.sort((left, right) => {
    const leftGroup = modelGroupRank(left.groupId, groupOrder)
    const rightGroup = modelGroupRank(right.groupId, groupOrder)
    if (leftGroup !== rightGroup) return leftGroup - rightGroup
    return WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind]
  })
}

function providerOrderIndex(provider: AgentId): number {
  const index = PROVIDER_ORDER.indexOf(provider)
  return index === -1 ? PROVIDER_ORDER.length : index
}

function mergeUsageAccount(
  accountsByKey: Map<string, UsageAccountEntry>,
  host: HostUsageInput,
  snapshot: AgentUsageLimits,
  now: number,
): boolean {
  const windows = buildAccountWindows(snapshot, now)
  const status = accountStatus(snapshot, windows)
  const stale = snapshot.stale || !host.connected
  const email = normalizeEmail(snapshot.accountEmail)
  const instanceId = snapshot.instanceId ?? snapshot.provider
  const providerLabel = usageProviderLabel(snapshot.provider)
  const displayName = snapshot.instanceLabel?.trim() || providerLabel
  const dedupKey = email
    ? `${snapshot.provider}:email:${email}`
    : `${host.serverId}:${snapshot.provider}:${instanceId}`

  const candidate: UsageAccountEntry = {
    key: dedupKey,
    provider: snapshot.provider,
    providerLabel,
    instanceId,
    displayName,
    email: snapshot.accountEmail?.trim() || null,
    planType: snapshot.planType,
    hosts: [{ serverId: host.serverId, label: host.label }],
    windows,
    status,
    stale,
    fetchedAt: snapshot.fetchedAt,
  }

  const existing = accountsByKey.get(dedupKey)
  if (!existing) {
    accountsByKey.set(dedupKey, candidate)
    return stale
  }

  const mergedHosts = existing.hosts.some((entry) => entry.serverId === host.serverId)
    ? existing.hosts
    : [...existing.hosts, { serverId: host.serverId, label: host.label }]
  const candidateFresher =
    (candidate.stale !== existing.stale && !candidate.stale) ||
    (candidate.stale === existing.stale && candidate.fetchedAt > existing.fetchedAt)
  const winner = candidateFresher ? candidate : existing
  accountsByKey.set(dedupKey, {
    ...winner,
    displayName: existing.displayName !== existing.providerLabel ? existing.displayName : winner.displayName,
    planType: winner.planType ?? existing.planType,
    hosts: mergedHosts,
  })
  return stale
}

function mergeUnsupportedProvider(
  accountsByKey: Map<string, UsageAccountEntry>,
  host: HostUsageInput,
  provider: AgentId,
): void {
  const dedupKey = `${provider}:unsupported`
  const existing = accountsByKey.get(dedupKey)
  if (!existing) {
    const providerLabel = usageProviderLabel(provider)
    accountsByKey.set(dedupKey, {
      key: dedupKey,
      provider,
      providerLabel,
      instanceId: provider,
      displayName: providerLabel,
      email: null,
      planType: null,
      hosts: [{ serverId: host.serverId, label: host.label }],
      windows: [],
      status: 'unsupported',
      stale: false,
      fetchedAt: 0,
    })
    return
  }
  if (existing.hosts.some((entry) => entry.serverId === host.serverId)) return
  accountsByKey.set(dedupKey, {
    ...existing,
    hosts: [...existing.hosts, { serverId: host.serverId, label: host.label }],
  })
}

/**
 * Aggregate quota snapshots across all selected hosts:
 * - Deduplicates shared accounts by `(provider, email)` keeping the freshest read.
 * - Applies weekly-blocks-session suppression.
 * - Computes even-pace markers and labels.
 * - Pools multiple subscription accounts per harness with next-refill previews.
 */
export function buildUsageOverview(hosts: readonly HostUsageInput[], now: number): UsageOverview {
  const loadingHosts: string[] = []
  const failedHosts: UsageFailedHost[] = []
  const staleHostSet = new Set<string>()
  const accountsByKey = new Map<string, UsageAccountEntry>()

  for (const host of hosts) {
    if (host.state === 'loading') {
      loadingHosts.push(host.label)
      continue
    }
    if (host.state === 'error') {
      failedHosts.push({
        serverId: host.serverId,
        label: host.label,
        message: host.error || 'Could not read usage limits.',
      })
      continue
    }
    const seenProviders = new Set<AgentId>()
    for (const snapshot of host.snapshots) {
      seenProviders.add(snapshot.provider)
      if (mergeUsageAccount(accountsByKey, host, snapshot, now)) {
        staleHostSet.add(host.label)
      }
    }
    for (const provider of host.availableProviders ?? []) {
      if (!UNSUPPORTED_USAGE_PROVIDERS.has(provider) || seenProviders.has(provider)) continue
      mergeUnsupportedProvider(accountsByKey, host, provider)
    }
  }

  const byProvider = new Map<AgentId, UsageAccountEntry[]>()
  for (const account of accountsByKey.values()) {
    const list = byProvider.get(account.provider)
    if (list) list.push(account)
    else byProvider.set(account.provider, [account])
  }

  const providers: UsageProviderGroup[] = [...byProvider.entries()]
    .sort(([left], [right]) => providerOrderIndex(left) - providerOrderIndex(right) || left.localeCompare(right))
    .map(([provider, accounts]) => {
      const sorted = [...accounts].sort((left, right) => {
        const leftReset = left.windows[0]?.resetsAt ?? Number.POSITIVE_INFINITY
        const rightReset = right.windows[0]?.resetsAt ?? Number.POSITIVE_INFINITY
        return leftReset - rightReset || left.displayName.localeCompare(right.displayName)
      })
      const windows = poolProviderWindows(sorted, now)
      const nonMeteredAccounts = sorted.filter((account) => account.status !== 'subscription')
      return {
        provider,
        label: usageProviderLabel(provider),
        accounts: sorted,
        windows,
        nonMeteredAccounts,
      }
    })

  return {
    providers,
    loadingHosts,
    failedHosts,
    staleHosts: [...staleHostSet],
  }
}

function windowMatchesState(window: UsagePoolWindow, state: UsageStateFilter): boolean {
  if (state === 'all') return true
  if (state === 'signed_out') return false
  const isBlocked =
    window.remainingPercent === 0 ||
    window.tone === 'spent' ||
    window.members.some((member) => member.window.suppressedByWeekly || member.window.tone === 'spent')
  const isAhead =
    window.remainingPercent > 0 &&
    (window.pace === 'ahead' || window.members.some((member) => member.window.pace === 'ahead' && member.window.remainingPercent > 0))
  if (state === 'ahead') return isAhead
  if (state === 'blocked') return isBlocked
  return isAhead || isBlocked || window.tone === 'low'
}

function nonMeteredMatchesState(account: UsageAccountEntry, state: UsageStateFilter): boolean {
  if (state === 'all') return true
  if (state === 'signed_out') return account.status === 'signed_out'
  if (state === 'issues') return account.status === 'signed_out' || account.status === 'unavailable'
  return false
}

export function filterUsageOverview(
  overview: UsageOverview,
  criteria: UsageFilterCriteria,
): UsageOverview {
  const providersFilter = criteria.providers
  const state = criteria.state ?? 'all'
  const filterByProvider = providersFilter !== undefined && providersFilter.size > 0
  if (!filterByProvider && state === 'all') return overview

  const providers: UsageProviderGroup[] = []
  for (const group of overview.providers) {
    if (filterByProvider && !providersFilter.has(group.provider)) continue
    const windows = group.windows.filter((window) => windowMatchesState(window, state))
    const nonMeteredAccounts = group.nonMeteredAccounts.filter((account) =>
      nonMeteredMatchesState(account, state),
    )
    if (windows.length === 0 && nonMeteredAccounts.length === 0) continue
    providers.push({
      ...group,
      windows,
      nonMeteredAccounts,
    })
  }
  return {
    ...overview,
    providers,
  }
}

export function groupUsageWindowsByModelGroup(
  windows: readonly UsagePoolWindow[],
): UsageModelGroupSection[] {
  const groups = new Map<string, { groupId: string | null; groupLabel: string | null; windows: UsagePoolWindow[] }>()
  for (const window of windows) {
    const key = window.groupId ?? ''
    const existing = groups.get(key)
    if (existing) existing.windows.push(window)
    else {
      groups.set(key, {
        groupId: window.groupId ?? null,
        groupLabel: window.groupLabel ?? null,
        windows: [window],
      })
    }
  }
  return [...groups.values()]
}

/**
 * Compute proportional `[0, 100]` chart domain extents for a pooled multi-account bar
 * so LayerChart draws each account track, quota fill, refill preview, and pace marker
 * on one shared linear x-axis.
 */
export function buildPooledBarSegments(
  window: UsagePoolWindow,
  displayMode: UsageDisplayMode,
  gapUnits = 1.2,
): UsagePooledChartSegment[] {
  const count = window.members.length
  if (count === 0) return []
  const totalWeight = window.members.reduce((sum, member) => sum + Math.max(0.01, member.weight), 0)
  const totalGap = count > 1 ? gapUnits * (count - 1) : 0
  const usableWidth = Math.max(10, 100 - totalGap)

  const segments: UsagePooledChartSegment[] = []
  let cursor = 0
  for (let index = 0; index < count; index += 1) {
    const member = window.members[index]!
    const weight = Math.max(0.01, member.weight)
    const width = (weight / totalWeight) * usableWidth
    const start = cursor
    const end = start + width
    cursor = end + gapUnits

    const display = formatUsagePercent(
      member.window.remainingPercent,
      member.window.usedPercent,
      displayMode,
    )
    const fillWidth = (display.barPercent / 100) * width
    const fillEnd = start + fillWidth

    const refillPct =
      member.window.resetsAt && displayMode === 'remaining'
        ? Math.min(100 - member.window.remainingPercent, member.window.refillPercent)
        : 0
    const refillWidth = (clampPercent(refillPct) / 100) * width
    const refillStart = end - refillWidth

    const pacePct =
      displayMode === 'used' ? member.window.paceUsedPercent : member.window.paceRemainingPercent
    const paceX =
      pacePct === null
        ? null
        : start + (Math.max(4, Math.min(96, pacePct)) / 100) * width

    const restoresPoolPercent = Math.round((member.window.refillPercent * weight) / totalWeight)

    segments.push({
      key: member.account.key,
      index,
      member,
      start,
      end,
      width,
      fillEnd,
      refillStart,
      refillEnd: end,
      paceX,
      restoresPoolPercent,
    })
  }
  return segments
}

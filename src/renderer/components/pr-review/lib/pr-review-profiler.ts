interface ProfileSample {
  label: string
  duration: number
  detail?: Record<string, unknown>
}

interface ProfileMark {
  label: string
  elapsed: number
  detail?: Record<string, unknown>
}

interface PrReviewProfile {
  number: number
  startedAt: number
  marks: ProfileMark[]
  samples: ProfileSample[]
  longTasks: ProfileSample[]
  observer: PerformanceObserver | null
  settleTimer: ReturnType<typeof setTimeout> | null
}

export interface PrReviewProfileReport {
  number: number
  total: number
  marks: ProfileMark[]
  work: Array<{ label: string; calls: number; total: number; max: number }>
  longTasks: ProfileSample[]
}

const isEnabled = Boolean(import.meta.env.DEV && typeof performance !== 'undefined')
const storedReportKey = 'solus:pr-review-profile'
let activeProfile: PrReviewProfile | null = null

function persistReport(report: PrReviewProfileReport): void {
  try {
    const serialized = JSON.stringify(report)
    localStorage.setItem(storedReportKey, serialized)
    localStorage.setItem(`${storedReportKey}:${Date.now()}`, serialized)
  } catch {
    // Profiling must never interfere with opening a review.
  }
}

const previousReport = (globalThis as typeof globalThis & { __solusPrProfile?: PrReviewProfileReport }).__solusPrProfile
if (isEnabled && previousReport) persistReport(previousReport)

function timingName(number: number, label: string): string {
  return `solus:pr-review:#${number}:${label}`
}

function finishActiveProfile(): void {
  const profile = activeProfile
  if (!profile) return
  profile.observer?.disconnect()
  if (profile.settleTimer) clearTimeout(profile.settleTimer)

  const total = performance.now() - profile.startedAt
  const workByLabel = new Map<string, { label: string; calls: number; total: number; max: number }>()
  for (const sample of profile.samples) {
    const aggregate = workByLabel.get(sample.label) ?? { label: sample.label, calls: 0, total: 0, max: 0 }
    aggregate.calls += 1
    aggregate.total += sample.duration
    aggregate.max = Math.max(aggregate.max, sample.duration)
    workByLabel.set(sample.label, aggregate)
  }
  const report: PrReviewProfileReport = {
    number: profile.number,
    total,
    marks: profile.marks,
    work: [...workByLabel.values()].sort((a, b) => b.total - a.total),
    longTasks: [...profile.longTasks].sort((a, b) => b.duration - a.duration),
  }

  ;(globalThis as typeof globalThis & { __solusPrProfile?: PrReviewProfileReport }).__solusPrProfile = report
  persistReport(report)
  console.info(`[Solus][PR_PROFILE_JSON] ${JSON.stringify(report)}`)
  console.groupCollapsed(`[Solus][PR profile] #${profile.number} settled in ${total.toFixed(1)}ms`)
  console.table(report.marks.map((mark) => ({ phase: mark.label, elapsedMs: Number(mark.elapsed.toFixed(1)), ...mark.detail })))
  console.table(report.work.map((work) => ({
    work: work.label,
    calls: work.calls,
    totalMs: Number(work.total.toFixed(1)),
    maxMs: Number(work.max.toFixed(1)),
  })))
  if (report.longTasks.length > 0) {
    console.table(report.longTasks.map((task) => ({ task: task.label, durationMs: Number(task.duration.toFixed(1)) })))
  }
  console.log('Latest report: window.__solusPrProfile')
  console.groupEnd()
  activeProfile = null
}

export function beginPrReviewProfile(number: number, options: { restart?: boolean } = {}): void {
  if (!isEnabled) return
  if (activeProfile?.number === number && !options.restart) return
  if (activeProfile) finishActiveProfile()

  const startedAt = performance.now()
  const profile: PrReviewProfile = {
    number,
    startedAt,
    marks: [],
    samples: [],
    longTasks: [],
    observer: null,
    settleTimer: null,
  }
  activeProfile = profile
  performance.mark(timingName(number, 'open'))

  if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
    profile.observer = new PerformanceObserver((list) => {
      if (activeProfile !== profile) return
      for (const entry of list.getEntries()) {
        if (entry.startTime < profile.startedAt) continue
        profile.longTasks.push({ label: entry.name || 'main-thread task', duration: entry.duration })
      }
    })
    profile.observer.observe({ type: 'longtask', buffered: true })
  }
}

export function markPrReviewProfile(label: string, detail?: Record<string, unknown>): void {
  const profile = activeProfile
  if (!profile || !isEnabled) return
  const now = performance.now()
  profile.marks.push({ label, elapsed: now - profile.startedAt, detail })
  performance.mark(timingName(profile.number, label), { detail })
}

export function profilePrReviewWork<T>(
  label: string,
  work: () => T,
  detail?: Record<string, unknown>,
): T {
  const profile = activeProfile
  if (!profile || !isEnabled) return work()
  const startedAt = performance.now()
  try {
    return work()
  } finally {
    const duration = performance.now() - startedAt
    profile.samples.push({ label, duration, detail })
    performance.measure(timingName(profile.number, label), {
      start: startedAt,
      duration,
      detail,
    })
  }
}

/** Report after one quiet second so Svelte, markdown, and diff post-render work
 * triggered by the final provider response is included in the trace. */
export function settlePrReviewProfile(): void {
  const profile = activeProfile
  if (!profile || !isEnabled) return
  if (profile.settleTimer) clearTimeout(profile.settleTimer)
  profile.settleTimer = setTimeout(() => {
    if (activeProfile === profile) finishActiveProfile()
  }, 1_000)
}

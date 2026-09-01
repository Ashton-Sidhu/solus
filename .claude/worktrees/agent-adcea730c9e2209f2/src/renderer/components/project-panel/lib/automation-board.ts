import type { Automation } from '../../../../shared/types'
import { relativeTime } from '../../automations/lib/automation-format'

// Reduces a project's automations to a glanceable status board for the panel.
// The full catalog lives on the Automations page; the panel answers a narrower
// question — "is anything happening, and does anything need me right now?" — so
// only automations worth a glance survive here.

/** Max rows the panel board renders before deferring the rest to "View all". */
export const AUTOMATION_BOARD_LIMIT = 3

export interface AutomationBoard {
  /** Ordered, capped rows: running → failed → favorite → soonest-scheduled. */
  rows: Automation[]
  /** Total project automations, drives the "View all N" footer. */
  total: number
  /** One-line header, e.g. "2 running · 1 failed · next in 12m" (may be empty). */
  summary: string
}

/**
 * Bucket every project automation by what earns a glance and keep the top N.
 * Running automations include session-bound ("runs in this chat") ones — those
 * are just automations whose run is in flight, so the running bucket covers them
 * without a special case. Each automation lands in exactly one bucket (highest
 * priority wins), so rows never duplicate. Paused / manual / idle automations
 * fall out entirely — they belong on the full Automations page, not the glance.
 */
export function buildAutomationBoard(automations: Automation[]): AutomationBoard {
  const running = automations.filter((a) => a.lastRunStatus === 'running')
  const settled = automations.filter((a) => a.lastRunStatus !== 'running')
  const failed = settled.filter((a) => a.lastRunStatus === 'failed')
  const rest = settled.filter((a) => a.lastRunStatus !== 'failed')
  const favorite = rest.filter((a) => a.favorite)
  const upNext = rest
    .filter((a) => !a.favorite && a.enabled && !!a.nextRunAt)
    .sort((a, b) => (a.nextRunAt! < b.nextRunAt! ? -1 : 1))

  const rows = [...running, ...failed, ...favorite, ...upNext].slice(0, AUTOMATION_BOARD_LIMIT)

  return {
    rows,
    total: automations.length,
    summary: summarize(automations, running.length, failed.length),
  }
}

/** Soonest pending fire across all enabled, non-running automations. */
function nextFire(automations: Automation[]): string | undefined {
  return automations
    .filter((a) => a.enabled && a.lastRunStatus !== 'running' && !!a.nextRunAt)
    .map((a) => a.nextRunAt!)
    .sort()[0]
}

function summarize(automations: Automation[], running: number, failed: number): string {
  const parts: string[] = []
  if (running) parts.push(`${running} running`)
  if (failed) parts.push(`${failed} failed`)
  const next = relativeTime(nextFire(automations))
  if (next) parts.push(`next ${next}`)
  return parts.join(' · ')
}

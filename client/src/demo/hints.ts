export const HINTS_STORAGE_KEY = 'solus-demo:hints'

export const DEMO_HINTS = [
  { id: 'watch-agent', label: 'Watch the agent work' },
  { id: 'read-migration-plan', label: 'Read the migration plan' },
  { id: 'open-architecture', label: 'Open the architecture diagram' },
  { id: 'edit-rollout-doc', label: 'Edit the rollout notes doc' },
  { id: 'walk-pr-review', label: 'Walk the PR review' },
  { id: 'drag-task', label: 'Drag a task card' },
] as const

export type DemoHintId = (typeof DEMO_HINTS)[number]['id']

interface HintTarget {
  selector: string
  targetText?: string
  textFallback?: string
}

const HINT_TARGETS: Record<DemoHintId, HintTarget> = {
  'watch-agent': { selector: '[data-testid="tab-item"][aria-label^="Add rate limiting to the API"]' },
  'read-migration-plan': {
    selector: '[aria-label="Plans gallery"] .plan-card, [aria-label="Plans gallery"] .row',
    targetText: 'Migrate billing to usage-based pricing',
    textFallback: 'Plans',
  },
  'open-architecture': {
    selector: '[aria-label="Folio gallery"] .folio-card, [aria-label="Folio gallery"] .pill-work-row',
    targetText: 'acme architecture',
    textFallback: 'Folio',
  },
  'edit-rollout-doc': {
    selector: '[aria-label="Folio gallery"] .folio-card, [aria-label="Folio gallery"] .pill-work-row',
    targetText: 'Rate limiting rollout notes',
    textFallback: 'Folio',
  },
  'walk-pr-review': {
    selector: '[aria-label="Pull Requests"] [role="button"], [aria-label="PR review tabs"]',
    targetText: '#142',
    textFallback: 'Pull Requests',
  },
  'drag-task': { selector: '[data-task-card]', textFallback: 'Tasks' },
}

function findTextTarget(text: string): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"], [role="tab"]'))
    .find((element) => element.textContent?.replace(/\s+/g, ' ').trim().startsWith(text))
}

export function loadCompletedHints(): DemoHintId[] {
  try {
    const stored = JSON.parse(localStorage.getItem(HINTS_STORAGE_KEY) ?? '[]')
    if (!Array.isArray(stored)) return []
    const validIds = new Set<string>(DEMO_HINTS.map(({ id }) => id))
    return stored.filter((id): id is DemoHintId => typeof id === 'string' && validIds.has(id))
  } catch {
    return []
  }
}

export function completeHint(completed: DemoHintId[], id: DemoHintId): DemoHintId[] {
  const next = completed.includes(id) ? completed : [...completed, id]
  try {
    localStorage.setItem(HINTS_STORAGE_KEY, JSON.stringify(next))
  } catch {}
  return next
}

function resolveHintTarget(id: DemoHintId): HTMLElement | undefined {
  const { selector, targetText, textFallback } = HINT_TARGETS[id]
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(selector))
  return (targetText
    ? candidates.find((element) => element.textContent?.includes(targetText))
    : candidates[0])
    ?? (textFallback ? findTextTarget(textFallback) : undefined)
}

/** Pulses the hint target a fixed number of times, e.g. after a click confirmation. */
export function pulseHintTarget(id: DemoHintId): boolean {
  try {
    const target = resolveHintTarget(id)
    if (!target) return false
    target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' })
    target.animate(PULSE_KEYFRAMES, { duration: 1100, easing: 'cubic-bezier(0.2, 0, 0, 1)', iterations: 3 })
    return true
  } catch {
    return false
  }
}

/** Pulses the hint target indefinitely — cancel the returned animation (e.g. on mouseleave) to stop it. */
export function startHintPulse(id: DemoHintId): Animation | undefined {
  try {
    const target = resolveHintTarget(id)
    if (!target) return undefined
    target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' })
    return target.animate(PULSE_KEYFRAMES, { duration: 1100, easing: 'cubic-bezier(0.2, 0, 0, 1)', iterations: Infinity })
  } catch {
    return undefined
  }
}

const PULSE_KEYFRAMES: Keyframe[] = [
  { outline: '0 solid color-mix(in srgb, var(--solus-accent) 0%, transparent)', outlineOffset: '2px' },
  { outline: '3px solid color-mix(in srgb, var(--solus-accent) 70%, transparent)', outlineOffset: '4px' },
  { outline: '0 solid color-mix(in srgb, var(--solus-accent) 0%, transparent)', outlineOffset: '7px' },
]

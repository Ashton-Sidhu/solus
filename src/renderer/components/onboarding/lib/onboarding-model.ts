import type { SetupAgent } from '../../../../shared/types'
import type { BindingId } from '../../../lib/keybindings/manifest'

/**
 * First-run onboarding: the one pass a fresh client makes before the workspace
 * opens. Every stage is the same shape — a centred title, a column of rows, and
 * a quiet Continue/Skip pair — so the flow reads as one screen changing its
 * mind rather than as a wizard with chapters.
 *
 * `intro` is the mark and the greeting. `start` is last because it is the only
 * stage that decides where the user lands, and the workspace opens the moment
 * it is answered.
 */
export type OnboardingStage = 'intro' | 'agents' | 'providers' | 'shortcuts' | 'start'

/** What the last stage decided, and therefore what the workspace opens with. */
export type OnboardingMode = 'project' | 'chat'

/** The asking stages, in order. `intro` is not one: it cannot be returned to. */
export const ONBOARDING_STAGES: OnboardingStage[] = [
  'agents',
  'providers',
  'shortcuts',
  'start',
]

/** The stage after this one, or null when the flow is over. */
export function nextStage(stage: OnboardingStage): OnboardingStage | null {
  if (stage === 'intro') return 'agents'
  const index = ONBOARDING_STAGES.indexOf(stage)
  return ONBOARDING_STAGES[index + 1] ?? null
}

/**
 * The stage before this one, or null when there is nowhere back to. The first
 * asking stage has no Back: the greeting is not a place to return to.
 */
export function previousStage(stage: OnboardingStage): OnboardingStage | null {
  const index = ONBOARDING_STAGES.indexOf(stage)
  return index > 0 ? ONBOARDING_STAGES[index - 1] : null
}

/** The two coding agents, with the marks the rows draw them with. */
export const AGENT_PRESENTATION = {
  claude: { abbr: 'CC', tint: 'var(--chart-1)' },
  codex: { abbr: 'CX', tint: 'var(--chart-4)' },
} satisfies Record<SetupAgent, { abbr: string; tint: string }>

/**
 * The six bindings worth learning on day one, in the order they are taught.
 * Real binding ids rather than literal keycaps: a shortcut card that prints a
 * combo the app does not answer to is a lie the user only discovers later.
 */
export const ONBOARDING_KEYS: Array<{ id: BindingId; label: string; hint: string }> = [
  { id: 'global.command-palette', label: 'Command palette', hint: 'Everything, from anywhere' },
  { id: 'global.new-task', label: 'New task', hint: 'Starts in a fresh worktree' },
  { id: 'global.session-picker', label: 'Session picker', hint: 'Jump between sessions' },
  { id: 'global.toggle-diff-panel', label: 'Toggle diff panel', hint: 'The diff for this session' },
  { id: 'global.select-project', label: 'Open project', hint: 'Also switches machine' },
  { id: 'global.toggle-sidebar', label: 'Toggle sidebar', hint: 'More room for the diff' },
]

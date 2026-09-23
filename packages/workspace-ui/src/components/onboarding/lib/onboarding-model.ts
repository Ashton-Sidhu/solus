import type { SetupAgent } from '@solus/contracts/types'
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
export type OnboardingStage =
  | 'intro'
  | 'shortcuts'
  | 'getting-around'
  | 'agents'
  | 'providers'
  | 'host'
  | 'start'
  | 'compute'
  | 'github'
  | 'project'

/**
 * Which onboarding this client gets (docs/plans/cloud-onboarding.md §2). The
 * connection decides, not the device: `host` for a client that talks to one
 * machine (the desktop app, or a browser paired to a machine), `cloud` for the
 * web client signed in at a Solus Cloud origin, where the account and its
 * organization come first and a machine is something the person chooses.
 */
export type OnboardingFlow = 'host' | 'cloud'

/** What the last stage decided, and therefore what the workspace opens with. */
export type OnboardingMode = 'project' | 'chat'

/**
 * Which flow this client gets. Not desktop-versus-web: a browser on a laptop
 * has the same keyboard and the same room as the desktop app, and its combos
 * are already resolved to web-safe defaults by `defaultCombo`. What actually
 * changes the flow is having no keyboard and no pointer.
 */
export type OnboardingSurface = 'pointer' | 'touch'

/** Touch-only means a phone or a tablet with nothing precise attached. */
export function surfaceFor(input: { isTouchDevice: boolean; hasKeyboardPointer: boolean }): OnboardingSurface {
  return input.isTouchDevice && !input.hasKeyboardPointer ? 'touch' : 'pointer'
}

/**
 * The asking stages, in order. `intro` is not one: it cannot be returned to.
 * Shortcuts come first: the keys are worth learning before any sign-in asks
 * the user to leave for a browser and come back.
 */
export const POINTER_STAGES: OnboardingStage[] = [
  'shortcuts',
  'agents',
  'providers',
  'start',
]

/**
 * The touch flow, which is shorter because most of the pointer flow is about a
 * machine this client is not.
 *
 * `shortcuts` becomes `getting-around`: seven ⌘-combos and an invitation to
 * press one are worth nothing to a thumb. `agents` and `providers` collapse
 * into `host`, because from a phone they are both asking about a *remote*
 * machine's setup — usually one already set up from its own desktop — so they
 * are worth one stage that reports where that machine stands, not two that ask.
 */
export const TOUCH_STAGES: OnboardingStage[] = ['getting-around', 'host', 'start']

/**
 * The cloud flow. Keys first, for the same reason as the host flow: the GitHub
 * stage sends the person to another tab. Then each stage makes the next one
 * possible: a machine, the agents on it, GitHub, and a repository. `agents` is
 * passed over when no machine was chosen (`skipsAgents`); skipping GitHub ends
 * the flow in the person's workspace instead of asking for a repository.
 */
export const CLOUD_POINTER_STAGES: OnboardingStage[] = ['shortcuts', 'compute', 'agents', 'github', 'project']
export const CLOUD_TOUCH_STAGES: OnboardingStage[] = ['getting-around', 'compute', 'agents', 'github', 'project']

export function stagesFor(surface: OnboardingSurface, flow: OnboardingFlow = 'host'): OnboardingStage[] {
  if (flow === 'cloud') return surface === 'touch' ? CLOUD_TOUCH_STAGES : CLOUD_POINTER_STAGES
  return surface === 'touch' ? TOUCH_STAGES : POINTER_STAGES
}

/** The stages this run shows: `agents` is absent when no machine was chosen. */
function visibleStages(surface: OnboardingSurface, flow: OnboardingFlow, skipsAgents: boolean): OnboardingStage[] {
  const stages = stagesFor(surface, flow)
  return skipsAgents ? stages.filter((stage) => stage !== 'agents') : stages
}

/** The stage after this one, or null when the flow is over. */
export function nextStage(
  stage: OnboardingStage,
  surface: OnboardingSurface,
  flow: OnboardingFlow = 'host',
  skipsAgents = false,
): OnboardingStage | null {
  const stages = visibleStages(surface, flow, skipsAgents)
  if (stage === 'intro') return stages[0]
  const index = stages.indexOf(stage)
  return stages[index + 1] ?? null
}

/**
 * The stage before this one, or null when there is nowhere back to. The first
 * asking stage has no Back: the greeting is not a place to return to.
 */
export function previousStage(
  stage: OnboardingStage,
  surface: OnboardingSurface,
  flow: OnboardingFlow = 'host',
  skipsAgents = false,
): OnboardingStage | null {
  const stages = visibleStages(surface, flow, skipsAgents)
  const index = stages.indexOf(stage)
  return index > 0 ? stages[index - 1] : null
}

/** The two coding agents, with the marks the rows draw them with. */
export const AGENT_PRESENTATION = {
  claude: { abbr: 'CC', tint: 'var(--chart-1)' },
  codex: { abbr: 'CX', tint: 'var(--chart-4)' },
} satisfies Record<SetupAgent, { abbr: string; tint: string }>

/**
 * The bindings worth learning on day one, in the order they are taught.
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

/**
 * The web shell has no desktop command palette. Teach only actions that its
 * root client registers, and prefer the task/session workflow a user needs
 * before the less important workspace controls.
 */
export const WEB_ONBOARDING_KEYS: typeof ONBOARDING_KEYS = [
  { id: 'global.new-task', label: 'New task', hint: 'Start work with a clean task' },
  { id: 'global.new-session', label: 'New session in task', hint: 'Continue the active task separately' },
  { id: 'global.new-session-without-task', label: 'Session without task', hint: 'Start a quick standalone session' },
  { id: 'global.select-project', label: 'Open project', hint: 'Choose a project on any connected host' },
  { id: 'global.session-picker', label: 'Session picker', hint: 'Jump between active sessions' },
  { id: 'global.toggle-diff-panel', label: 'Toggle diff panel', hint: 'Review changes in this session' },
  { id: 'global.toggle-workspace', label: 'Open workspace', hint: 'See plans, documents and diagrams' },
]

export function onboardingKeysFor(isWeb: boolean): typeof ONBOARDING_KEYS {
  return isWeb ? WEB_ONBOARDING_KEYS : ONBOARDING_KEYS
}

/** The mark a gesture row draws, resolved to an icon by the stage. */
export type GestureGlyph = 'swipe' | 'tap' | 'plus' | 'back'

/**
 * What the touch flow teaches in place of the keys. Every one of these is a
 * gesture the mobile layout already answers to, for the same reason the
 * shortcut cards read their combos off the binding table: a card describing an
 * interaction the app does not have is a lie the user only discovers later.
 */
export const ONBOARDING_GESTURES: Array<{ glyph: GestureGlyph; label: string; hint: string }> = [
  { glyph: 'swipe', label: 'Swipe in from the left edge', hint: 'Sessions, projects and machines' },
  { glyph: 'tap', label: 'Tap the title', hint: 'Jump between sessions' },
  { glyph: 'plus', label: 'The + beside the composer', hint: 'Diff, files and machines' },
  { glyph: 'back', label: 'Back', hint: 'Closes what is open, one layer at a time' },
]

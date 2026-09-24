/**
 * First-run onboarding: the one pass a fresh client makes before the workspace
 * opens. Every stage is the same shape — a centred title, a column of rows, and
 * a quiet Continue/Skip pair — so the flow reads as one screen changing its
 * mind rather than as a wizard with chapters.
 *
 * `intro` is the mark and the greeting. `start` is last because it is the only
 * stage that decides where the user lands, and the workspace opens the moment
 * it is answered. The optional `cloud-connect` offer on desktop comes just
 * before it, so the flow ends on the choice of where to work.
 */
export type OnboardingStage =
  | 'intro'
  | 'getting-around'
  | 'agents'
  | 'providers'
  | 'host'
  | 'start'
  | 'compute'
  | 'github'
  | 'project'
  /** Naming a new project. Not in any stage list: `start` or `project` opens it,
   *  and Back returns to whichever did. */
  | 'name-project'
  /** Choosing existing code. Not in any stage list: `start` opens it, and Back
   *  returns there. */
  | 'open-project'
  /** The optional Solus Cloud offer. Listed in the host flow before `start`,
   *  and shown only where the shell holds an account (desktop). */
  | 'cloud-connect'

/**
 * Which onboarding this client gets (docs/plans/cloud-onboarding.md §2). The
 * connection decides, not the device: `host` for a client that talks to one
 * machine (the desktop app, or a browser paired to a machine), `cloud` for the
 * web client signed in at a Solus Cloud origin, where the account and its
 * organization come first and a machine is something the person chooses.
 */
export type OnboardingFlow = 'host' | 'cloud'

/** What the last stage decided, and therefore what the workspace opens with:
 *  a project to create, an existing one to open, or a chat. */
export type OnboardingMode = 'new-project' | 'project' | 'chat'

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

/** The asking stages, in order. `intro` is not one: it cannot be returned to. */
export const POINTER_STAGES: OnboardingStage[] = ['agents', 'providers', 'cloud-connect', 'start']

/**
 * The touch flow, which is shorter because most of the pointer flow is about a
 * machine this client is not.
 *
 * It opens with `getting-around`, because a thumb has no keys to find the
 * drawers with. `agents` and `providers` collapse
 * into `host`, because from a phone they are both asking about a *remote*
 * machine's setup — usually one already set up from its own desktop — so they
 * are worth one stage that reports where that machine stands, not two that ask.
 */
export const TOUCH_STAGES: OnboardingStage[] = ['getting-around', 'host', 'cloud-connect', 'start']

/**
 * The cloud flow. Each stage makes the next one possible: a machine, the
 * agents on it, GitHub, and a repository. `agents` is passed over when no
 * machine was chosen (`skipsAgents`); skipping GitHub ends the flow in the
 * person's workspace instead of asking for a repository.
 */
export const CLOUD_POINTER_STAGES: OnboardingStage[] = ['compute', 'agents', 'github', 'project']
export const CLOUD_TOUCH_STAGES: OnboardingStage[] = ['getting-around', 'compute', 'agents', 'github', 'project']

export function stagesFor(surface: OnboardingSurface, flow: OnboardingFlow = 'host'): OnboardingStage[] {
  if (flow === 'cloud') return surface === 'touch' ? CLOUD_TOUCH_STAGES : CLOUD_POINTER_STAGES
  return surface === 'touch' ? TOUCH_STAGES : POINTER_STAGES
}

/** What this run can show, beyond the surface and the flow. */
export interface StageConditions {
  /** The cloud flow has no machine to ask about agents. */
  skipsAgents?: boolean
  /** The shell holds a Solus Cloud account to connect (desktop). */
  offersCloudConnect?: boolean
}

/** The stages this run shows: `agents` needs a machine, `cloud-connect` an account. */
function visibleStages(
  surface: OnboardingSurface,
  flow: OnboardingFlow,
  conditions: StageConditions,
): OnboardingStage[] {
  return stagesFor(surface, flow).filter(
    (stage) =>
      !(stage === 'agents' && conditions.skipsAgents) &&
      !(stage === 'cloud-connect' && !conditions.offersCloudConnect),
  )
}

/** The stage after this one, or null when the flow is over. */
export function nextStage(
  stage: OnboardingStage,
  surface: OnboardingSurface,
  flow: OnboardingFlow = 'host',
  conditions: StageConditions = {},
): OnboardingStage | null {
  const stages = visibleStages(surface, flow, conditions)
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
  conditions: StageConditions = {},
): OnboardingStage | null {
  const stages = visibleStages(surface, flow, conditions)
  const index = stages.indexOf(stage)
  return index > 0 ? stages[index - 1] : null
}

/** The mark a gesture row draws, resolved to an icon by the stage. */
export type GestureGlyph = 'swipe' | 'tap' | 'plus' | 'back'

/**
 * What the touch flow teaches. Every one of these is a gesture the mobile
 * layout already answers to: a card describing an interaction the app does
 * not have is a lie the user only discovers later.
 */
export const ONBOARDING_GESTURES: Array<{ glyph: GestureGlyph; label: string; hint: string }> = [
  { glyph: 'swipe', label: 'Swipe in from the left edge', hint: 'Sessions, projects and machines' },
  { glyph: 'tap', label: 'Tap the title', hint: 'Jump between sessions' },
  { glyph: 'plus', label: 'The + beside the composer', hint: 'Diff, files and machines' },
  { glyph: 'back', label: 'Back', hint: 'Closes what is open, one layer at a time' },
]

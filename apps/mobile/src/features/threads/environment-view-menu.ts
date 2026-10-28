import {
  ENVIRONMENT_VIEWS,
  ENVIRONMENT_VIEW_LABELS,
  environmentViewFor,
  type EnvironmentView,
  type EnvironmentViewFacts,
} from '@solus/client-core/environment-view'
import type { ScreenHeaderMenu } from '../../components/ScreenHeader.types'

/**
 * The thread header's environment menu: the phone's form of the desktop
 * Environment card's view row. It names the session's view by the shared rule
 * and offers Browser, Builds, and Artifacts.
 */

const VIEW_ICON = { browser: 'globe', builds: 'hammer', artifacts: 'sparkles' } as const satisfies { readonly [view in EnvironmentView]: string }

/** Window-only choices, keyed by host and session, as on desktop. */
const choices = new Map<string, EnvironmentView>()

export function chosenEnvironmentView(hostId: string, sessionId: string): EnvironmentView | undefined {
  return choices.get(`${hostId}\u0000${sessionId}`)
}

export function chooseEnvironmentView(hostId: string, sessionId: string, view: EnvironmentView): void {
  choices.set(`${hostId}\u0000${sessionId}`, view)
}

export function phoneEnvironmentFacts(input: { chosen?: EnvironmentView; artifactCount: number; artifactsKnown: boolean }): EnvironmentViewFacts {
  // The phone reads no device previews, so only a choice makes Builds the view here.
  return { ...input, sessionShowsDevice: false }
}

export function environmentViewMenu(facts: EnvironmentViewFacts, onChoose: (view: EnvironmentView) => void): ScreenHeaderMenu {
  const view = environmentViewFor(facts)
  return {
    title: 'Environment',
    icon: VIEW_ICON[view ?? 'browser'],
    status: view ? ENVIRONMENT_VIEW_LABELS[view] : 'Checking session…',
    items: ENVIRONMENT_VIEWS.map((option) => ({
      id: option,
      title: ENVIRONMENT_VIEW_LABELS[option],
      icon: VIEW_ICON[option],
      selected: option === view,
      onPress: () => onChoose(option),
    })),
  }
}

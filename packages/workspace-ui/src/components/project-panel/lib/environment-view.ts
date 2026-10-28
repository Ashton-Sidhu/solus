import { SvelteMap } from 'svelte/reactivity'
import type { EnvironmentView } from '@solus/client-core/environment-view'

/**
 * What the user chose per session on this client. It is kept for the life of
 * the window and is keyed by host and session, so one session's choice never
 * changes another's.
 */
export class EnvironmentViewChoices {
  private readonly choices = new SvelteMap<string, EnvironmentView>()

  chosenFor(serverId: string, sessionKey: string): EnvironmentView | undefined {
    return this.choices.get(choiceKey(serverId, sessionKey))
  }

  choose(serverId: string, sessionKey: string, view: EnvironmentView): void {
    this.choices.set(choiceKey(serverId, sessionKey), view)
  }
}

function choiceKey(serverId: string, sessionKey: string): string {
  return `${serverId}\u0000${sessionKey}`
}

export const environmentViewChoices = new EnvironmentViewChoices()

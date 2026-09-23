import type { OnboardingStage } from './onboarding-model'

/**
 * The "Get started" list on the new-tab home for a Solus Cloud account
 * (docs/plans/cloud-onboarding.md §3.7): what cloud onboarding asked and the
 * person skipped. Every item is a live fact read from the stores that own it,
 * never a stored copy, so an item goes away the moment its fact becomes true —
 * wherever it was made true. Each item reopens the onboarding stage that sets it.
 */

export type GetStartedItemId = 'machine' | 'agents' | 'github' | 'project'

export interface GetStartedItem {
  id: GetStartedItemId
  label: string
  detail: string
  /** The onboarding stage that sets this fact. */
  stage: OnboardingStage
}

export interface GetStartedFacts {
  /** A machine the account can run agents on: its cloud host, its own, or a shared one. */
  hasMachine: boolean
  /** Some machine the account can use reports a coding agent signed in; null while unknown. */
  hasSignedInAgent: boolean | null
  /** GitHub on the account; null while the workspace service has not answered. */
  githubConnected: boolean | null
  /** The organization has at least one project in Solus Cloud; null while unknown. */
  hasProject: boolean | null
}

/**
 * The open items, in the order onboarding asks them. An unknown fact is not
 * shown as open: an item that appears and then vanishes when the answer comes
 * is worse than one that appears a moment late. Agents wait for a machine,
 * because there is nothing to sign in on without one; a project waits for
 * GitHub for the same reason.
 */
export function getStartedItems(facts: GetStartedFacts): GetStartedItem[] {
  const items: GetStartedItem[] = []
  if (!facts.hasMachine) {
    items.push({ id: 'machine', label: 'Choose where agents run', detail: 'The cloud host or your own computer', stage: 'compute' })
  } else if (facts.hasSignedInAgent === false) {
    items.push({ id: 'agents', label: 'Sign in Claude Code or Codex', detail: 'On the machine your agents run on', stage: 'agents' })
  }
  if (facts.githubConnected === false) {
    items.push({ id: 'github', label: 'Connect GitHub', detail: 'To clone repositories and see pull requests', stage: 'github' })
  }
  // The project stage lists GitHub repositories; without GitHub it has nothing to offer.
  if (facts.githubConnected === true && facts.hasProject === false) {
    items.push({ id: 'project', label: 'Add a project', detail: 'A repository everyone in the organization can use', stage: 'project' })
  }
  return items
}

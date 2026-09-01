// What a project's task provider choice means, as one shape the trigger label
// and the menu rows both read from. Shaping only — the save itself is a project
// config write, which the page owns.
import type { AtlassianJiraProject } from '@solus/contracts/atlassian'
import type { TaskProviderId } from '@solus/contracts/task-types'

/** The choice a menu row commits. GitHub carries no scope because the checkout
 *  already owns that answer. Jira carries its project because no checkout can
 *  infer it, so the two are chosen together rather than left to a follow-up. */
export type TaskProviderChoice =
  | { provider: 'local' }
  | { provider: 'github' }
  | { provider: 'jira'; projectKey: string }

const PROVIDER_LABELS = {
  local: 'Local tasks',
  github: 'GitHub',
  jira: 'Jira',
} satisfies Record<TaskProviderId, string>

/**
 * The trigger's label: the system, then where in it. Both upstream providers
 * name their pinned scope so a changed or broken binding stays visible.
 */
export function taskProviderLabel(provider: TaskProviderId, scopeLabel: string | null): string {
  if (provider === 'github' && scopeLabel) return `GitHub · ${scopeLabel}`
  if (provider === 'jira' && scopeLabel) return `Jira · ${scopeLabel}`
  return PROVIDER_LABELS[provider]
}

/** How the header control presents itself. */
export interface TaskProviderTriggerSpec {
  /** The pill's text. */
  label: string
  /** Its tooltip: what this project does with its tasks today. */
  title: string
  /** Nothing upstream yet. The control then invites rather than reports — it
   *  takes the accent treatment and shows the marks it could connect to, because
   *  a project whose tasks nobody else can see is a state worth naming. */
  unbound: boolean
}

export function taskProviderTrigger(
  provider: TaskProviderId,
  scopeLabel: string | null,
  detectedRepo: { owner: string; repo: string } | null,
): TaskProviderTriggerSpec {
  if (provider === 'local') {
    return {
      label: 'Connect provider',
      // The detected repository is named here rather than in the label: it is
      // what the GitHub row will bind, not what this click does.
      title: detectedRepo
        ? `Tasks live only in Solus. Sync them with ${detectedRepo.owner}/${detectedRepo.repo} or a Jira project.`
        : 'Tasks live only in Solus. Sync them with GitHub or Jira.',
      unbound: true,
    }
  }
  const label = taskProviderLabel(provider, scopeLabel)
  return { label, title: `Tasks in this project are filed in ${label}`, unbound: false }
}

/** GitHub is not a repository browser. Its task binding always follows this
 *  checkout's GitHub origin, so no origin means there is nothing valid to bind. */
export function githubUnavailableReason(
  detectedRepo: { owner: string; repo: string } | null,
): string | null {
  return detectedRepo ? null : 'Add a GitHub origin remote first'
}

/** Why Jira cannot be chosen right now, or null when it can. The menu states
 *  this instead of hiding the row: an absent option reads as "not supported". */
export function jiraUnavailableReason(input: {
  connected: boolean
  reachesJira: boolean
  projectCount: number
  loading: boolean
  /** What the last load actually failed with, if it did. */
  error: string | null
}): string | null {
  if (!input.connected) return 'Connect Atlassian in Settings first'
  if (!input.reachesJira) return 'This Atlassian connection does not reach Jira'
  if (input.loading) return null
  // A failed read outranks every guess about why the list is empty. Reporting
  // "no projects" for a call that never succeeded is how an expired grant came
  // to read as an empty site.
  if (input.error) return input.error
  if (!input.projectCount) return 'No Jira projects on the connected site'
  return null
}

/** Matches the picker's filter against both halves of a project, because people
 *  search by whichever one they remember. */
export function matchesJiraProject(project: AtlassianJiraProject, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return project.key.toLowerCase().includes(needle) || project.name.toLowerCase().includes(needle)
}

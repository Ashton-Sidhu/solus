import type { AutomationTrigger } from '../../../../shared/types'

// The starter automations offered on the landing page's ledger. Each one is a
// complete, runnable automation — the prompt is what actually goes to the agent,
// not a placeholder the user is expected to rewrite.

export interface AutomationTemplate {
  id: string
  /** Ledger title, and the name the seeded automation is created under. */
  name: string
  /** The ledger's prose column — what the automation does, in one sentence. */
  description: string
  /** Instructions submitted to the agent verbatim on every run. */
  prompt: string
  trigger: AutomationTrigger
}

/** The prompt that hands a one-line description off to an agent session, which
 *  authors the automation with its `create_automation` tool. The agent has to be
 *  told where to run it — a headless run has no ambient working directory. */
export function draftAutomationPrompt(description: string, cwd: string): string {
  return [
    'Set up an automation for me:',
    '',
    description.trim(),
    '',
    `Create it with the create_automation tool, with its working directory set to ${cwd}. Write the instructions out in full — they are all the agent running it will see, so they have to stand alone without this conversation.`,
    'Pick the schedule the description implies, and leave it manual if none is implied. Ask me before saving if the cadence or the scope is ambiguous.',
  ].join('\n')
}

export const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
  {
    id: 'architecture-diagram',
    name: 'Architecture diagram, kept current',
    description:
      'Maps services, data flow and entry points, then revises the diagram whenever the structure moves.',
    prompt: [
      'Keep this project\'s architecture diagram current.',
      '',
      'Walk the repository and map its services, data flow and entry points — how a request or user action travels from the outermost boundary through to storage. Compare that against the existing architecture diagram work if one exists.',
      '',
      'If nothing structural has changed since the last run, say so and stop without editing anything. Otherwise update the diagram to match, and note in your summary exactly which structures moved and why.',
    ].join('\n'),
    trigger: { type: 'cron', expr: '0 7 * * *' },
  },
  {
    id: 'docs-sync',
    name: 'Docs sync',
    description:
      "Spots user-facing changes in yesterday's commits and updates the pages that describe them.",
    prompt: [
      'Review the commits from the last 24 hours and bring the documentation back in line with them.',
      '',
      'Only consider user-facing changes: new or removed features, changed flags, renamed commands, altered defaults, breaking API changes. Ignore refactors, formatting and internal-only work.',
      '',
      'For each one, find the pages that describe the old behaviour and update them. Do not invent documentation for things that were never documented. If nothing user-facing landed, say so and make no edits.',
    ].join('\n'),
    trigger: { type: 'cron', expr: '0 6 * * *' },
  },
  {
    id: 'release-notes',
    name: 'Release notes from merged PRs',
    description:
      'Collects everything merged since the last tag and drafts notes grouped by feature, fix and internal.',
    prompt: [
      'Draft release notes for the changes merged since the most recent git tag.',
      '',
      'Collect the merged pull requests in that range and group them under Features, Fixes and Internal. Write each entry from the user\'s point of view — what changed for them — rather than restating the commit subject. Call out breaking changes in their own section at the top.',
      '',
      'Leave the notes as a draft for review; do not tag or publish a release.',
    ].join('\n'),
    trigger: { type: 'manual' },
  },
  {
    id: 'dependency-upkeep',
    name: 'Dependency upkeep',
    description:
      'Bumps outdated and vulnerable packages one small PR at a time, running the test suite before each.',
    prompt: [
      'Bring this project\'s dependencies up to date, conservatively.',
      '',
      'List the outdated and vulnerable packages, then handle them one at a time — security fixes first, then patch and minor bumps. Run the test suite after each bump and stop on the first failure rather than batching everything together.',
      '',
      'Open one small pull request per bump (or per tightly-coupled group) so each can be reviewed and reverted on its own. Leave major-version bumps out; report them for a human to decide.',
    ].join('\n'),
    trigger: { type: 'cron', expr: '0 8 * * 1' },
  },
  {
    id: 'flaky-tests',
    name: 'Flaky test report',
    description:
      'Re-runs the suite, finds tests that pass and fail without code changes, and files one issue listing them.',
    prompt: [
      'Find the flaky tests in this project.',
      '',
      'Run the full test suite several times against an unchanged working tree and record which tests do not produce the same result every time. A test that fails consistently is broken, not flaky — leave those out.',
      '',
      'File a single issue listing the flaky tests, each with its failure rate across the runs and the failure output. If nothing was flaky, say so and file nothing.',
    ].join('\n'),
    trigger: { type: 'cron', expr: '0 21 * * 0' },
  },
]

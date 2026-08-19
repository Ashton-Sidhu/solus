import {
  DEFAULT_SOURCE_CONTROL_WRITING,
  type SourceControlWritingPreferences,
} from '@solus/contracts/types'
import { runAsync } from './exec'

export interface SourceControlWritingPolicy {
  commitInstructions: string
  pullRequestInstructions: string
  followPullRequestTemplate: boolean
}

function normalized(
  preferences: SourceControlWritingPreferences | null | undefined,
): SourceControlWritingPreferences {
  return preferences ?? DEFAULT_SOURCE_CONTROL_WRITING
}

async function recentCommitSubjects(cwd: string): Promise<string[]> {
  const output = await runAsync(
    'git',
    ['log', '-n', '20', '--no-merges', '--pretty=format:%s'],
    cwd,
  ).catch(() => '')
  return output
    .split(/\r?\n/)
    .map((subject) => subject.trim())
    .filter(Boolean)
}

export async function resolveSourceControlWritingPolicy(
  cwd: string,
  preferences: SourceControlWritingPreferences | null | undefined,
): Promise<SourceControlWritingPolicy> {
  const style = normalized(preferences)
  if (style.mode === 'conventional_commits') {
    return {
      commitInstructions: [
        'Use Conventional Commits: type(scope): concise imperative subject.',
        'Use the smallest accurate type and omit the scope when it adds no information.',
      ].join('\n'),
      pullRequestInstructions: [
        'Keep the pull request title concise.',
        'Do not force Conventional Commit syntax into the title unless the repository already uses it.',
      ].join('\n'),
      followPullRequestTemplate: style.followPullRequestTemplate,
    }
  }
  if (style.mode === 'custom') {
    const instructions = style.customInstructions
    return {
      commitInstructions: instructions,
      pullRequestInstructions: instructions,
      followPullRequestTemplate: style.followPullRequestTemplate,
    }
  }

  const subjects = await recentCommitSubjects(cwd)
  const examples = subjects.length > 0
    ? `Recent commit subjects from this repository:\n${subjects.join('\n')}`
    : 'No recent commit subjects are available. Use concise, specific plain language.'
  return {
    commitInstructions: [
      "Follow the repository's established commit-message style when the examples show one.",
      examples,
    ].join('\n\n'),
    pullRequestInstructions: [
      "Follow the repository's established pull-request title and body style when the commit examples show one.",
      examples,
    ].join('\n\n'),
    followPullRequestTemplate: style.followPullRequestTemplate,
  }
}

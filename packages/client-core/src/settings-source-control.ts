import type { SourceControlWritingMode } from '@solus/contracts/types'

/** Shared by the host connection row, account connection row, and native screen. */
export const githubSetting = { label: 'GitHub' }

export const sourceControlWritingOptions = {
    repo_conventions: {
      label: "Repository conventions",
      description: "Commit messages and pull request titles and descriptions match each repository's history.",
    },
    conventional_commits: {
      label: "Conventional Commits",
      description: "Commit messages use Conventional Commit prefixes. Pull request titles and descriptions stay short and plain.",
    },
    custom: {
      label: "Custom instructions",
      description: "Your instructions shape commit messages, branch names, and pull request titles and descriptions.",
    },
  } satisfies Record<SourceControlWritingMode, { label: string; description: string }>;

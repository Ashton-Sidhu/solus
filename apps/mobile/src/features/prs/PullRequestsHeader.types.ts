export interface PullRequestsHeaderProps {
  readonly searchQuery: string
  readonly onSearchQueryChange: (query: string) => void
  readonly onOpenSettings: () => void
  readonly onOpenEnvironments: () => void
}

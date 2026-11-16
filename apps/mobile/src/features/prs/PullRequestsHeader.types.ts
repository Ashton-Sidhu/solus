import type { pullRequestListFilterMenus } from './lib/filter-menus'

export interface PullRequestsHeaderProps {
  readonly searchQuery: string
  readonly onSearchQueryChange: (query: string) => void
  readonly filterMenu:
    | ReturnType<typeof pullRequestListFilterMenus>['headerMenu']
    | null
  readonly onOpenEnvironments: () => void
}

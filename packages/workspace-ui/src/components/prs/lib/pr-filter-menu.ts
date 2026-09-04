import type { ListIcon } from '../../ui/list-page'

export interface PrFilterOption {
  value: string
  label: string
  icon?: ListIcon
  avatarUrl?: string
  color?: string
  count?: number
}

/** One visible row and its radio submenu in the PR Filters menu. */
export interface PrFilterGroup {
  key: 'state' | 'involvement' | 'author' | 'labels' | 'draft' | 'review' | 'checks'
  label: string
  icon: ListIcon
  value: string
  valueLabel: string
  active: boolean
  searchable?: boolean
  options: PrFilterOption[]
  select: (value: string) => void
}

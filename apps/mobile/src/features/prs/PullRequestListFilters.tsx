// Adapted from T3 Code features/pull-requests/PullRequestListFilters.tsx (MIT, see UPSTREAM.md).
import { ActivityIndicator, Platform, ScrollView, View } from 'react-native'
import { ListFilterMenu } from '../workspace/ListFilterMenu'
import type { pullRequestListFilterMenus } from './lib/filter-menus'

/** iOS has a More pill; Android puts all filters in the header. */
export function PullRequestListFilters(props: {
  readonly filters: ReturnType<typeof pullRequestListFilterMenus>
  readonly refreshing?: boolean
}) {
  const filters = props.filters
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{
        paddingHorizontal: 16,
        paddingTop: 2,
        paddingBottom: 10,
        gap: 8,
      }}
    >
      {props.refreshing ? (
        <View className="justify-center" accessibilityLiveRegion="polite">
          <ActivityIndicator
            size="small"
            colorClassName="accent-icon-muted"
            accessibilityLabel="Updating pull requests"
          />
        </View>
      ) : null}
      {Platform.OS === 'android' ? null : (
        <ListFilterMenu
          label={filters.count ? String(filters.count) : 'Filters'}
          icon
          active={filters.count > 0}
          accessibilityLabel={
            filters.count ? `Filters, ${filters.count} active` : 'More filters'
          }
          actions={filters.more}
          onSelect={filters.select}
        />
      )}
      {filters.hostLabel !== null ? (
        <ListFilterMenu
          label={filters.hostLabel}
          accessibilityLabel="Choose pull request host"
          actions={filters.hostActions}
          onSelect={filters.select}
        />
      ) : null}
      <ListFilterMenu
        label={filters.stateLabel}
        active={filters.stateActive}
        accessibilityLabel="Filter by state"
        actions={filters.stateActions}
        onSelect={filters.select}
      />
      <ListFilterMenu
        label={filters.involvementLabel}
        active={filters.involvementActive}
        accessibilityLabel="Filter by involvement"
        actions={filters.involvementActions}
        onSelect={filters.select}
      />
      <ListFilterMenu
        label={filters.labelCount ? `Labels ${filters.labelCount}` : 'Labels'}
        active={filters.labelCount > 0}
        accessibilityLabel="Filter by label"
        actions={filters.labelActions}
        onSelect={filters.select}
      />
      <ListFilterMenu
        label={
          filters.author === 'me' ? 'By you' : (filters.author ?? 'Author')
        }
        active={Boolean(filters.author)}
        accessibilityLabel="Filter by author"
        actions={filters.authorActions}
        onSelect={filters.select}
      />
    </ScrollView>
  )
}

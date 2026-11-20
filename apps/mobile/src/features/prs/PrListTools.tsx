import { Alert, Pressable, View } from 'react-native'
import type { PrViewFilters } from '@solus/contracts/pr-views'
import { AppText as Text } from '../../components/AppText'
import type { PullRequestListPreferences } from '../workspace/list-preferences'
import { capturePrView, applyPrView } from './lib/pr-saved-views'
import { PrUrlInput } from './PrUrlInput'
import { PrSavedViews } from './PrSavedViews'

export function PrListTools(props: {
  preferences: PullRequestListPreferences
  query: string
  hostId: string | null
  scopeHostIds: readonly string[]
  pairedHostIds: readonly string[]
  onPreferencesChange: (value: PullRequestListPreferences) => void
  onQueryChange: (query: string) => void
  metadataError: string | null
  retryMetadata: () => void
}) {
  const apply = (filters: PrViewFilters) => {
    const owner = filters.project?.hostId ?? filters.hostId
    if (owner && !props.pairedHostIds.includes(owner)) {
      Alert.alert('Saved view unavailable', 'Connect its host and retry.')
      return
    }
    props.onPreferencesChange(applyPrView(filters))
    props.onQueryChange(filters.query)
  }
  return (
    <>
      {props.metadataError ? (
        <View className="gap-2 px-4 pb-3">
          <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
            {props.metadataError}
          </Text>
          <Pressable accessibilityRole="button" onPress={props.retryMetadata}>
            <Text className="text-sm text-primary-text">Retry review filters</Text>
          </Pressable>
        </View>
      ) : null}
      <PrUrlInput hostId={props.hostId ?? props.scopeHostIds[0] ?? null} />
      <PrSavedViews filters={capturePrView(props.preferences, props.query)} onApply={apply} />
    </>
  )
}

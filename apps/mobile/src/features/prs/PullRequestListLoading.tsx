import { ActivityIndicator, View } from 'react-native'
import { AppText as Text } from '../../components/AppText'

export function PullRequestListLoading() {
  return (
    <View accessibilityRole="progressbar" accessibilityLabel="Loading pull requests" accessibilityState={{ busy: true }} className="px-4 pt-2">
      <View className="h-8 flex-row items-center gap-2">
        <ActivityIndicator size="small" colorClassName="accent-icon-muted" />
        <Text className="text-xs text-foreground-muted">Loading pull requests</Text>
        <View className="h-px flex-1 bg-border-subtle" />
      </View>
      <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        {[44, 61, 36, 51, 42, 57].map((width, index) => (
          <View key={index} className="h-[76px] flex-row items-center gap-3" style={{ opacity: 1 - index * 0.15 }}>
            <View className="h-4 w-3 rounded-sm bg-subtle" />
            <View className="min-w-0 flex-1 gap-2.5">
              <View className="h-2.5 max-w-lg rounded-full bg-subtle" style={{ width: `${width}%` }} />
              <View className="flex-row items-center gap-2">
                <View className="h-2 w-7 rounded-full bg-subtle" />
                <View className="h-2 w-12 rounded-full bg-subtle" />
                <View className="size-3.5 rounded-full bg-subtle" />
                <View className="h-2 w-16 rounded-full bg-subtle" />
              </View>
            </View>
            <View className="h-2 w-8 rounded-full bg-subtle" />
          </View>
        ))}
      </View>
    </View>
  )
}

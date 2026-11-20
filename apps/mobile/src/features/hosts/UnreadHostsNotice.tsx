import { ActivityIndicator, Platform, Pressable, View } from 'react-native'

import { useApp, useListened } from '../../app/app-context'
import { AppText as Text } from '../../components/AppText'
import { cn } from '../../lib/cn'
import { unreadHosts, type UnreadHosts } from './lib/unread-hosts'

function useUnreadHosts(): UnreadHosts[] {
  const app = useApp()
  const listState = useListened(app.registry.changes, app.registry.listState)
  const directoryState = useListened(app.registry.changes, app.registry.directoryState)
  return unreadHosts(listState, directoryState)
}

/**
 * Below a host picker: the reads whose hosts it cannot offer yet (plans/033 §3 Q2).
 * Loading shows a spinner; a failed read offers Try again. Nothing shows when both
 * reads answered.
 */
export function UnreadHostsNotice() {
  const app = useApp()
  const unread = useUnreadHosts()
  if (unread.length === 0) return null
  const retry = (answer: UnreadHosts['answer']) => {
    void (answer === 'list' ? app.registry.refreshList() : app.account.refreshDirectory())
  }
  return (
    <View
      collapsable={false}
      className={cn('overflow-hidden bg-grouped-card', Platform.OS === 'android' ? 'rounded-[28px]' : 'rounded-2xl')}
    >
      {unread.map((read, index) => (
        <View
          key={read.answer}
          collapsable={false}
          className={cn('min-h-12 flex-row items-center gap-3 px-4 py-3', index < unread.length - 1 && 'border-b border-border-subtle')}
        >
          {read.state === 'loading' ? <ActivityIndicator size="small" colorClassName="accent-icon-muted" /> : null}
          <Text accessibilityRole={read.state === 'loading' ? 'text' : undefined} className="min-w-0 flex-1 text-sm text-foreground-muted">
            {read.text}
          </Text>
          {read.state === 'failed' ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Try again: ${read.text}`}
              onPress={() => retry(read.answer)}
              className="rounded-full bg-subtle px-3.5 py-2 active:opacity-70"
            >
              <Text className="text-xs font-t3-bold text-foreground">Try again</Text>
            </Pressable>
          ) : null}
        </View>
      ))}
    </View>
  )
}

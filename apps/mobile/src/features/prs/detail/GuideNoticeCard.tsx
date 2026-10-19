// Adapted from T3 Code apps/mobile/src/features/pull-requests/guide/GuideNotice.tsx (MIT, see UPSTREAM.md).
import { useState } from 'react'
import { Pressable, View } from 'react-native'
import { SymbolView } from '../../../components/AppSymbol'
import { AppText as Text } from '../../../components/AppText'
import type { GuideNotice } from '../lib/pull-request-guide-state'
import { OFFLINE_REASON } from './pull-request-view'

type GuideNoticeProps = { readonly compact: boolean; readonly canWrite: boolean; readonly onWrite: () => void; readonly onReload: () => void }

/** One place for the guide's state and its action, so it does not jump as the
 *  state changes. A ready guide shows no card. The card itself holds no state:
 *  a guide that becomes ready, or stops being ready, keeps the hook order. */
export function GuideNoticeCard(props: GuideNoticeProps & { readonly notice: GuideNotice }) {
  const { notice, ...rest } = props
  if (notice.kind === 'ready') return null
  return <GuideNoticeBody notice={notice} {...rest} />
}

function GuideNoticeBody(props: GuideNoticeProps & { readonly notice: GuideNotice }) {
  const { notice } = props
  const failed = notice.kind === 'failed' || notice.kind === 'unavailable'
  const busy = notice.kind === 'loading' || notice.kind === 'writing'
  const actionable = notice.kind === 'unavailable' || (props.canWrite && !busy)
  const [detailsOpen, setDetailsOpen] = useState(false)
  return (
    <View className={props.compact ? 'rounded-2xl bg-grouped-card p-4' : 'rounded-2xl bg-grouped-card p-5'} accessibilityLiveRegion="polite" accessibilityState={{ busy }}>
      <View className="flex-row items-center gap-3">
        <SymbolView name={failed ? 'exclamationmark.circle' : busy ? 'clock' : 'list.number'} size={19} tintColorClassName={failed ? 'accent-danger-foreground' : 'accent-icon-muted'} />
        <Text className="text-base font-t3-semibold">{notice.title}</Text>
      </View>
      <View style={props.compact ? undefined : { minHeight: 72 }} className="pt-3 pb-4">
        <Text className="text-sm leading-6 text-foreground-muted">{notice.description}</Text>
        {notice.details ? (
          <View className="gap-2 pt-2">
            <Pressable accessibilityRole="button" accessibilityState={{ expanded: detailsOpen }} onPress={() => setDetailsOpen((open) => !open)} className="min-h-11 flex-row items-center gap-1.5 self-start active:opacity-60">
              <SymbolView name={detailsOpen ? 'chevron.down' : 'chevron.right'} size={11} tintColorClassName="accent-icon-muted" />
              <Text className="text-xs text-foreground-muted">{detailsOpen ? 'Hide details' : 'Show details'}</Text>
            </Pressable>
            {detailsOpen ? (
              <View className="rounded-lg bg-secondary p-3">
                <Text selectable className="font-mono text-2xs leading-normal text-foreground-muted">{notice.details}</Text>
              </View>
            ) : null}
          </View>
        ) : null}
      </View>
      <View className="min-h-12 flex-row items-center gap-3">
        {actionable || busy ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: busy, busy }}
            disabled={busy}
            style={{ minWidth: 152 }}
            className={props.compact ? 'min-h-12 items-center justify-center rounded-full bg-secondary px-4 active:opacity-70' : 'min-h-12 items-center justify-center rounded-full bg-foreground px-4 active:opacity-70'}
            onPress={notice.kind === 'unavailable' ? props.onReload : props.onWrite}
          >
            <Text className={props.compact ? 'text-center font-t3-medium text-secondary-foreground' : 'text-center font-t3-medium text-screen'}>{notice.action}</Text>
          </Pressable>
        ) : (
          <Text className="shrink text-xs text-foreground-muted">{OFFLINE_REASON}</Text>
        )}
      </View>
    </View>
  )
}

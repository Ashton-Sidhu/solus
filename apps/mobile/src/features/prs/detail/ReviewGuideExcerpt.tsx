// Adapted from T3 Code apps/mobile/src/features/pull-requests/guide/ReviewGuideExcerpt.tsx (MIT, see UPSTREAM.md).
import { useMemo, useState } from 'react'
import { Pressable, View } from 'react-native'
import { SymbolView } from '../../../components/AppSymbol'
import { AppText as Text } from '../../../components/AppText'
import { CODE_FONT } from '../../../theme/tokens'
import { parseNativeReviewDiffDebugEvent, resolveNativeReviewDiffView } from '../../diffs/nativeReviewDiffSurface'
import { buildNativeReviewDiffData, NATIVE_REVIEW_DIFF_CONTENT_WIDTH } from '../../review/nativeReviewDiffAdapter'
import { buildReviewParsedDiff } from '../../review/reviewModel'
import { useNativeReviewDiffBridge } from '../../review/useNativeReviewDiffBridge'
import { useAppearanceCodeSurface } from '../../settings/appearance/useAppearanceCodeSurface'
import { useAppearancePreferences } from '../../settings/appearance/AppearancePreferencesProvider'
import { guideExcerptText, type GuideExcerpt } from '../lib/pull-request-guide-tour'

const EMPTY_IDS: readonly string[] = []

/**
 * The hunks of one file that a guide stop is about, on the diff surface with
 * no file or hunk rows and no scrolling of its own: the page scrolls, and the
 * surface is as tall as its rows (the native `metrics` event). The path row
 * opens the file in the Files tab.
 */
export function ReviewGuideExcerpt(props: { readonly excerpt: GuideExcerpt; readonly onOpen: () => void }) {
  const { excerpt } = props
  const { nativeReviewDiffStyle, codeWordBreak } = useAppearanceCodeSurface()
  const { themeAppearance } = useAppearancePreferences()
  const sectionId = `guide:${excerpt.path}:${excerpt.focus?.start ?? 0}`
  const data = useMemo(() => {
    const parsed = buildNativeReviewDiffData(buildReviewParsedDiff(excerpt.patch, sectionId))
    // Real line numbers give the context; file and hunk rows would repeat the header above.
    return { ...parsed, rows: parsed.rows.filter((row) => row.kind !== 'file' && row.kind !== 'hunk') }
  }, [excerpt.patch, sectionId])
  const bridge = useNativeReviewDiffBridge({
    threadKey: null,
    sectionId,
    diff: excerpt.patch,
    data,
    collapsedFileIds: EMPTY_IDS,
    viewedFileIds: EMPTY_IDS,
    selectedRowIds: EMPTY_IDS,
    canHighlight: true,
  })
  const measurementKey = `${excerpt.patch}:${codeWordBreak}:${nativeReviewDiffStyle.rowHeight}`
  const [measured, setMeasured] = useState<{ key: string; height: number } | null>(null)
  const [NativeDiff] = useState(() => resolveNativeReviewDiffView())
  const range = excerpt.focus ? `${excerpt.focus.start}–${excerpt.focus.end}` : null
  return (
    <View className="overflow-hidden rounded-lg border border-border-subtle">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${excerpt.path}${range ? ` at lines ${range}` : ''} in Files`}
        onPress={props.onOpen}
        className="min-h-11 flex-row items-center gap-3 border-b border-border-subtle px-3 py-2 active:opacity-60"
      >
        <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1} ellipsizeMode="middle">{excerpt.path}</Text>
        {range ? <Text className="text-2xs text-foreground-muted">{range}</Text> : null}
        <SymbolView name="arrow.up.right" size={13} tintColorClassName="accent-icon-muted" />
      </Pressable>
      {NativeDiff && data.rows.length > 0 ? (
        <View style={{ height: measured?.key === measurementKey ? measured.height : data.rows.length * nativeReviewDiffStyle.rowHeight }}>
          <NativeDiff
            scrollEnabled={false}
            bounces={false}
            appearanceScheme={themeAppearance}
            rowHeight={nativeReviewDiffStyle.rowHeight}
            contentWidth={NATIVE_REVIEW_DIFF_CONTENT_WIDTH}
            style={{ flex: 1 }}
            rowsJson={bridge.rowsJson}
            themeJson={bridge.themeJson}
            styleJson={bridge.styleJson}
            tokensPatchJson={bridge.tokensPatchJson}
            tokensResetKey={bridge.tokensResetKey}
            onDebug={(event) => {
              bridge.onDebug(event)
              const { message, contentHeight } = parseNativeReviewDiffDebugEvent(event.nativeEvent)
              if (message === 'metrics' && contentHeight !== undefined) {
                setMeasured((current) => current?.key === measurementKey && current.height === contentHeight ? current : { key: measurementKey, height: contentHeight })
              }
            }}
            onPressLine={props.onOpen}
          />
        </View>
      ) : (
        // Without the diff surface in this build, the hunks are plain text.
        <Text selectable className="p-3 text-xs text-foreground" style={{ fontFamily: CODE_FONT }}>
          {guideExcerptText(excerpt.patch)}
        </Text>
      )}
    </View>
  )
}

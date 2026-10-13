// Adapted from T3 Code apps/mobile/src/features/pull-requests/PullRequestDescription.tsx (MIT, see UPSTREAM.md).
import { Image } from 'expo-image'
import { useMemo, useState } from 'react'
import { Platform, Pressable, ScrollView, View } from 'react-native'
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg'
import { SymbolView } from '../../../components/AppSymbol'
import { AppText as Text } from '../../../components/AppText'
import { FilePreview, type ResolvedFilePreviewSource } from '../../../components/FilePreview'
import { MediaVideoPlayer } from '../../../components/MediaVideoPlayer'
import { useAppearancePreferences } from '../../settings/appearance/AppearancePreferencesProvider'
import { pullRequestAttachments, type PullRequestAttachment } from '../lib/pull-request-markdown'
import { PullRequestMarkdown } from './PullRequestMarkdown'
import { usePullRequestMediaUrl } from './use-pull-request-media-url'
import { PullRequestSectionHeading } from './pull-request-ui'

const COLLAPSED_HEIGHT = 240

/**
 * The description, cut at a fixed height with "Show more", and a strip of its
 * images and videos below it. Badges that bots put in a body are not in the
 * strip (`isBotBadgeImage`).
 */
export function PullRequestDescription(props: { readonly markdown: string; readonly expanded: boolean; readonly onExpandedChange: (expanded: boolean) => void }) {
  const { expanded, onExpandedChange } = props
  const [bodyHeight, setBodyHeight] = useState(0)
  const { themeVariables: colors } = useAppearancePreferences()
  const fadeColor = colors[Platform.OS === 'android' ? '--color-sheet-solid' : '--color-screen']
  const attachments = useMemo(() => pullRequestAttachments(props.markdown), [props.markdown])
  const canCollapse = bodyHeight > COLLAPSED_HEIGHT
  const collapsed = canCollapse && !expanded
  return (
    <View className="gap-5">
      <View className="gap-3">
        <PullRequestSectionHeading>Description</PullRequestSectionHeading>
        {props.markdown.trim() ? (
          <View className="overflow-hidden">
            <View style={{ height: expanded ? bodyHeight : Math.min(bodyHeight, COLLAPSED_HEIGHT), overflow: 'hidden' }}>
              {/* The full body is measured apart from the cut view. */}
              <View style={{ position: 'absolute', top: 0, left: 0, right: 0 }} onLayout={(event) => setBodyHeight(event.nativeEvent.layout.height)}>
                <PullRequestMarkdown markdown={props.markdown} />
              </View>
            </View>
            {collapsed ? (
              <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 80, zIndex: 1 }}>
                <Svg width="100%" height={80}>
                  <Defs>
                    <LinearGradient id="description-fade" x1="0" y1="0" x2="0" y2="80" gradientUnits="userSpaceOnUse">
                      <Stop offset="0" stopColor={fadeColor} stopOpacity={0} />
                      <Stop offset="0.5" stopColor={fadeColor} stopOpacity={0.94} />
                      <Stop offset="1" stopColor={fadeColor} stopOpacity={1} />
                    </LinearGradient>
                  </Defs>
                  <Rect width="100%" height="100%" fill="url(#description-fade)" />
                </Svg>
              </View>
            ) : null}
            {canCollapse ? (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded }}
                accessibilityLabel={expanded ? 'Collapse description' : 'Expand description'}
                onPress={() => onExpandedChange(!expanded)}
                style={collapsed ? { position: 'absolute', bottom: 2, left: 0, right: 0, height: 44, zIndex: 2 } : undefined}
                className="min-h-11 flex-row items-center justify-center gap-1 py-2 active:opacity-70"
              >
                <Text className="text-xs font-t3-medium text-foreground">{expanded ? 'Show less' : 'Show more'}</Text>
                <SymbolView name={expanded ? 'chevron.up' : 'chevron.down'} size={10} tintColorClassName="accent-foreground" />
              </Pressable>
            ) : null}
          </View>
        ) : (
          <Text className="text-sm text-foreground-muted">No description provided.</Text>
        )}
      </View>
      {attachments.length > 0 ? <Attachments attachments={attachments} /> : null}
    </View>
  )
}

function Attachments({ attachments }: { readonly attachments: readonly PullRequestAttachment[] }) {
  const [preview, setPreview] = useState<ResolvedFilePreviewSource | null>(null)
  return (
    <View className="gap-3">
      <PullRequestSectionHeading>Attachments</PullRequestSectionHeading>
      <ScrollView horizontal keyboardShouldPersistTaps="always" scrollsToTop={false} showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 12 }}>
        {attachments.map((attachment) => <AttachmentTile key={attachment.uri} attachment={attachment} onPreview={setPreview} />)}
      </ScrollView>
      {preview ? <FilePreview source={preview} onRequestClose={() => setPreview(null)} /> : null}
    </View>
  )
}

/** One image or video of the strip; GitHub media loads through the host. */
function AttachmentTile({ attachment, onPreview }: { readonly attachment: PullRequestAttachment; readonly onPreview: (source: ResolvedFilePreviewSource) => void }) {
  const media = usePullRequestMediaUrl(attachment.uri)
  const uri = media.uri
  if (attachment.kind !== 'image') {
    return (
      <View style={{ width: 176 }}>
        <MediaVideoPlayer uri={uri} name={attachment.caption} thumbnailKey={`url:${attachment.uri}`} resolvePlaybackUri={media.resolvePlaybackUri} />
      </View>
    )
  }
  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel={`View attachment: ${attachment.caption}`}
      disabled={uri === null}
      onPress={() => { if (uri) onPreview({ kind: 'image', uri, name: attachment.caption, caption: attachment.uri }) }}
      className="gap-2 active:opacity-70"
      style={{ width: 176 }}
    >
      <View className="overflow-hidden rounded-2xl border border-border-subtle bg-grouped-card">
        {uri ? <Image source={{ uri }} style={{ width: 174, height: 112 }} contentFit="contain" cachePolicy="memory-disk" /> : <View style={{ width: 174, height: 112 }} />}
      </View>
      <Text numberOfLines={1} className="text-xs text-foreground-muted">{attachment.caption}</Text>
    </Pressable>
  )
}

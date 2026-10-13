// Adapted from T3 Code apps/mobile/src/features/pull-requests/PullRequestMarkdown.tsx and PullRequestMedia.tsx (MIT, see UPSTREAM.md).
import { memo, useCallback, useContext, useMemo, useState } from 'react'
import { Linking, View } from 'react-native'
import { useApp } from '../../../app/app-context'
import { FilePreview, type ResolvedFilePreviewSource } from '../../../components/FilePreview'
import { MediaVideoPlayer } from '../../../components/MediaVideoPlayer'
import { resolveMarkdownLinkPresentation } from '../../../lib/markdownLinks'
import { useNativeMarkdownTextStyle } from '../../../lib/nativeMarkdownTextStyle'
import { SelectableMarkdownText, type MarkdownImageRenderer, type MarkdownImageSourceResolver } from '../../../native/SelectableMarkdownText'
import { ThreadMarkdownImageUnavailable, ThreadMarkdownImageView } from '../../threads/ThreadMarkdownImage'
import { splitPullRequestBody, type AttachmentMedia } from '../lib/pull-request-markdown'
import { pullRequestMediaUrl } from '../pull-request-media'
import { PullRequestMediaContext, usePullRequestMediaUrl } from './use-pull-request-media-url'

/**
 * A pull request body, comment, or guide text in the transcript's selectable
 * Markdown. A standalone media link draws as the media itself. GitHub media
 * loads through a URL the host signs (`usePullRequestMediaUrl`), so uploads
 * in a private repository show too; other media loads from its own address.
 */

function fileName(url: string): string {
  try {
    return new URL(url).pathname.split('/').pop() || 'Attachment'
  } catch {
    return 'Attachment'
  }
}

/** One image or video from a web address. */
export function PullRequestMedia(props: { readonly url: string; readonly kind: AttachmentMedia; readonly caption?: string; readonly onPreview: (source: ResolvedFilePreviewSource) => void }) {
  const media = usePullRequestMediaUrl(props.url)
  const name = props.caption || fileName(props.url)
  // As T3: an upload that is not known to be an image plays as a video.
  if (props.kind !== 'image') return <MediaVideoPlayer uri={media.uri} name={name} thumbnailKey={`url:${props.url}`} resolvePlaybackUri={media.resolvePlaybackUri} />
  return (
    <ThreadMarkdownImageView
      uri={media.uri}
      sourceKey={props.url}
      unavailable={false}
      alt={name}
      name={name}
      caption={props.url}
      onPressPreview={props.onPreview}
    />
  )
}

export const PullRequestMarkdown = memo(function PullRequestMarkdown(props: { readonly markdown: string }) {
  const app = useApp()
  const textStyle = useNativeMarkdownTextStyle('assistant')
  const [preview, setPreview] = useState<ResolvedFilePreviewSource | null>(null)
  const location = useContext(PullRequestMediaContext)
  const segments = useMemo(() => splitPullRequestBody(props.markdown), [props.markdown])
  const onLinkPress = useCallback((href: string) => {
    const presentation = resolveMarkdownLinkPresentation(href)
    if (presentation.kind === 'external') void app.platform.openBrowser(presentation.href)
    else if (presentation.kind === 'link' && presentation.href) void Linking.openURL(presentation.href)
  }, [app])
  const renderImage = useCallback<MarkdownImageRenderer>((image) => {
    const presentation = resolveMarkdownLinkPresentation(image.href)
    // A relative image names a file in the repository, which the phone cannot read.
    if (presentation.kind !== 'external') return <ThreadMarkdownImageUnavailable alt={image.alt} />
    return <PullRequestMedia url={presentation.href} kind="image" caption={image.alt ?? undefined} onPreview={setPreview} />
  }, [])
  /** An image Enriched draws itself (in a table, list, or quote): GitHub media through the host's signed URL. */
  const imageUri = useCallback((href: string): Promise<string> | null => {
    const presentation = resolveMarkdownLinkPresentation(href)
    if (presentation.kind !== 'external') return null
    if (!location) return Promise.resolve(presentation.href)
    return pullRequestMediaUrl(app.connections.connection(location.hostId), presentation.href, app.pullRequests.context(location.projectPath))
  }, [app, location])
  const resolveImageSource = useCallback<MarkdownImageSourceResolver>(async (image) => {
    const uri = imageUri(image.href)
    if (uri === null) throw new Error('Markdown image is unavailable')
    return { uri: await uri }
  }, [imageUri])
  const onImagePress = useCallback((href: string) => {
    void imageUri(href)?.then((uri) => setPreview({ kind: 'image', uri, name: fileName(href), caption: href }))
  }, [imageUri])
  return (
    <View style={{ gap: 12 }}>
      {segments.map((segment) => segment.kind === 'markdown' ? (
        <SelectableMarkdownText key={segment.id} markdown={segment.text} textStyle={textStyle} onLinkPress={onLinkPress} renderImage={renderImage} resolveImageSource={resolveImageSource} onImagePress={onImagePress} />
      ) : (
        <PullRequestMedia key={segment.id} url={segment.url} kind={segment.media} onPreview={setPreview} />
      ))}
      {preview ? <FilePreview source={preview} onRequestClose={() => setPreview(null)} /> : null}
    </View>
  )
})

// Adapted from T3 Code apps/mobile/src/features/pull-requests/PullRequestMarkdown.tsx and PullRequestMedia.tsx (MIT, see UPSTREAM.md).
import { memo, useCallback, useMemo, useState } from 'react'
import { Linking, View } from 'react-native'
import { useApp } from '../../../app/app-context'
import { FilePreviewGallery } from '../../../components/FilePreviewGallery'
import type { FilePreviewSource } from '../../../components/FilePreview.types'
import { FilePreviewModal } from '../../../components/FilePreviewModal'
import { MediaVideoPlayer } from '../../../components/MediaVideoPlayer'
import { VideoPreviewModal, type VideoPreviewSource } from '../../../components/VideoPreviewModal'
import { resolveMarkdownLinkPresentation } from '../../../lib/markdownLinks'
import { resolveMarkdownMediaPreview } from '../../../lib/markdownMedia'
import { useNativeMarkdownTextStyle } from '../../../lib/nativeMarkdownTextStyle'
import { SelectableMarkdownText, type MarkdownImageRenderer, type MarkdownImageSourceResolver } from '../../../native/SelectableMarkdownText'
import { isSvgImage, ThreadMarkdownImageUnavailable, ThreadMarkdownImageView } from '../../threads/ThreadMarkdownImage'
import { pullRequestImageGallery, splitPullRequestBody, type AttachmentMedia } from '../lib/pull-request-markdown'
import { usePullRequestMarkdownMedia, usePullRequestMediaUrl } from './use-pull-request-media-url'

/**
 * A pull request body, comment, or guide text in the transcript's selectable
 * Markdown. A standalone media link draws as the media itself. GitHub media
 * loads through a URL the host signs (`usePullRequestMediaUrl`), so uploads
 * in a private repository show too; other media loads from its own address.
 * A tapped image opens a gallery of every image in the text.
 */

/** One image or video from a web address. */
export function PullRequestMedia(props: { readonly url: string; readonly kind: AttachmentMedia; readonly caption?: string; readonly onPreview: (source: FilePreviewSource) => void }) {
  const media = usePullRequestMediaUrl(props.url)
  const preview = resolveMarkdownMediaPreview(props.url, usePullRequestMarkdownMedia(), props.kind === 'image')
  const name = props.caption || preview?.source.name || 'Attachment'
  // As T3: an upload that is not known to be an image plays as a video.
  if (props.kind !== 'image') return <MediaVideoPlayer uri={media.uri} name={name} thumbnailKey={`url:${props.url}`} resolvePlaybackUri={media.resolvePlaybackUri} actionsSource={preview?.source.actionsSource} />
  return (
    <ThreadMarkdownImageView
      uri={media.uri}
      sourceKey={props.url}
      unavailable={false}
      format={isSvgImage(props.url) ? 'svg' : undefined}
      alt={name}
      {...(preview?.kind === 'image' ? { preview: { ...preview.source, name } } : {})}
      onPressPreview={props.onPreview}
    />
  )
}

export const PullRequestMarkdown = memo(function PullRequestMarkdown(props: { readonly markdown: string }) {
  const app = useApp()
  const textStyle = useNativeMarkdownTextStyle('assistant')
  const [filePreview, setFilePreview] = useState<FilePreviewSource | null>(null)
  const [videoPreview, setVideoPreview] = useState<VideoPreviewSource | null>(null)
  const media = usePullRequestMarkdownMedia()
  const segments = useMemo(() => splitPullRequestBody(props.markdown), [props.markdown])
  const gallery = useMemo(() => pullRequestImageGallery(props.markdown, media), [props.markdown, media])
  const openMarkdownLink = useCallback((href: string, imageEmbed: boolean) => {
    const preview = resolveMarkdownMediaPreview(href, media, imageEmbed)
    if (preview?.kind === 'video') return setVideoPreview((current) => current ?? preview.source)
    if (preview) return setFilePreview((current) => current ?? preview.source)
    const presentation = resolveMarkdownLinkPresentation(href)
    if (presentation.kind === 'external') void app.platform.openBrowser(presentation.href)
    else if (presentation.kind === 'link' && presentation.href) void Linking.openURL(presentation.href)
  }, [app, media])
  const onLinkPress = useCallback((href: string) => openMarkdownLink(href, false), [openMarkdownLink])
  const onImagePress = useCallback((href: string) => openMarkdownLink(href, true), [openMarkdownLink])
  const renderImage = useCallback<MarkdownImageRenderer>((image) => {
    const presentation = resolveMarkdownLinkPresentation(image.href)
    // A relative image names a file in the repository, which the phone cannot read.
    if (presentation.kind !== 'external') return <ThreadMarkdownImageUnavailable alt={image.alt} />
    return <PullRequestMedia url={presentation.href} kind="image" caption={image.alt ?? undefined} onPreview={setFilePreview} />
  }, [])
  /** An image Enriched draws itself (in a table, list, or quote): GitHub media through the host's signed URL. */
  const resolveImageSource = useCallback<MarkdownImageSourceResolver>(async (image) => {
    const preview = resolveMarkdownMediaPreview(image.href, media, true)
    const uri = preview?.kind === 'image' ? await preview.source.resolveUri() : null
    if (uri === null) throw new Error('Markdown image is unavailable')
    return { uri }
  }, [media])
  return (
    <FilePreviewGallery value={gallery}>
      <View style={{ gap: 12 }}>
        {segments.map((segment) => segment.kind === 'markdown' ? (
          <SelectableMarkdownText key={segment.id} markdown={segment.text} textStyle={textStyle} onLinkPress={onLinkPress} renderImage={renderImage} resolveImageSource={resolveImageSource} onImagePress={onImagePress} />
        ) : (
          <PullRequestMedia key={segment.id} url={segment.url} kind={segment.media} onPreview={setFilePreview} />
        ))}
        <FilePreviewModal source={filePreview} onRequestClose={() => setFilePreview(null)} />
        <VideoPreviewModal source={videoPreview} onRequestClose={() => setVideoPreview(null)} />
      </View>
    </FilePreviewGallery>
  )
})

// Adapted from T3 Code apps/mobile/src/features/files/ThreadFilesRouteScreen.tsx (MIT, see UPSTREAM.md).
import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react'
import { ActivityIndicator, Pressable, View } from 'react-native'
import type { FilePreviewResult } from '@solus/contracts/types'
import { useApp, useListened } from '../../app/app-context'
import { AudioFilePreview } from '../../components/AudioFilePreview'
import { SymbolView } from '../../components/AppSymbol'
import { AppText as Text } from '../../components/AppText'
import { ControlPillMenu } from '../../components/ControlPill'
import { EmptyState } from '../../components/EmptyState'
import { MediaVideoPlayer } from '../../components/MediaVideoPlayer'
import { copyTextWithHaptic } from '../../lib/copyTextWithHaptic'
import type { ScreenProps } from '../../navigation/routes'
import { HostStatusBanner } from '../hosts/HostStatusBanner'
import { projectContext } from '../conversation/lib/ipc-context'
import { useAppearancePreferences } from '../settings/appearance/AppearancePreferencesProvider'
import { FileMarkdownPreview } from './FileMarkdownPreview'
import { useHostMediaUrl } from './host-media-url'
import { fileSizeLabel } from './lib/file-tree'
import { fileMediaView, isMarkdownFile, type FileMediaView } from './lib/file-preview-kind'
import { SourceFileSurface } from './SourceFileSurface'
import { WorkspaceFileImagePreview } from './WorkspaceFileImagePreview'

type FileView =
  | { kind: 'loading' }
  | { kind: 'loaded'; file: FilePreviewResult }
  | { kind: 'error'; message: string }

function FilePreviewLoading(props: { readonly message: string }) {
  return (
    <View className="flex-1 items-center justify-center gap-3 bg-sheet px-6">
      <ActivityIndicator />
      <Text className="text-center text-sm text-foreground-muted">{props.message}</Text>
    </View>
  )
}

function FilePreviewNotice(props: { readonly title?: string; readonly children: string }) {
  return (
    <View className="border-b border-warning-border bg-warning px-4 py-2">
      {props.title ? <Text className="text-2xs font-t3-bold uppercase text-warning-foreground">{props.title}</Text> : null}
      <Text className="text-xs leading-snug text-warning-foreground">{props.children}</Text>
    </View>
  )
}

/**
 * An image, video, audio file, or document from the host, through a URL the
 * host signs. A document (PDF, SVG) opens in the browser. When the host does
 * not serve the file, `fallback` shows instead.
 */
function HostFileMedia(props: {
  readonly hostId: string
  readonly projectPath: string
  readonly path: string
  readonly view: FileMediaView
  readonly fallback: ReactNode
}) {
  const app = useApp()
  const connection = app.connections.connection(props.hostId)
  const ctx = useMemo(() => projectContext(props.projectPath, app.account.organizationId), [app, props.projectPath])
  const { state, refresh } = useHostMediaUrl(connection, { path: props.path, ctx })
  const [audioAttempt, setAudioAttempt] = useState(0)
  const name = props.path.slice(props.path.lastIndexOf('/') + 1)

  if (state.kind === 'failed') return props.fallback
  const uri = state.kind === 'ready' ? state.url : null
  switch (props.view) {
    case 'image':
      return <WorkspaceFileImagePreview accessibilityLabel={name} uri={uri} caption={props.path} />
    case 'video':
      return (
        <View className="flex-1 items-center justify-center bg-sheet p-4">
          <MediaVideoPlayer uri={uri} resolvePlaybackUri={refresh} name={name} thumbnailKey={`host-file:${props.hostId}:${props.path}`} />
        </View>
      )
    case 'audio':
      return uri === null
        ? <FilePreviewLoading message="Loading file..." />
        : (
          <AudioFilePreview
            key={`${uri}:${audioAttempt}`}
            uri={uri}
            onRetry={() => { void refresh().then(() => setAudioAttempt((value) => value + 1)) }}
          />
        )
    case 'document':
      return (
        <View className="flex-1 items-center justify-center bg-sheet px-6">
          <EmptyState
            title={name}
            detail="This file opens in the browser."
            {...(uri ? { actionLabel: 'Open', onAction: () => void app.platform.openBrowser(uri) } : {})}
          />
        </View>
      )
  }
}

/**
 * One file, read-only, as T3 Code's file screen: numbered source with Shiki
 * colors, a rendered preview for Markdown, and media through the host. The
 * header menu wraps long lines, switches Markdown between preview and
 * source, and copies the path or the contents.
 */
export function FileScreen({ navigation, route }: ScreenProps<'File'>) {
  const { hostId, projectPath, path } = route.params
  const app = useApp()
  const { appearance, setCodeWordBreak } = useAppearancePreferences()
  const phase = useListened(app.connections.changes, () => app.connections.state(hostId)?.phase)
  const [view, setView] = useState<FileView>({ kind: 'loading' })
  const [markdownMode, setMarkdownMode] = useState<'source' | 'preview'>('source')
  const contents = view.kind === 'loaded' && view.file.ok && view.file.kind === 'text' ? view.file.contents : null
  const truncated = view.kind === 'loaded' && view.file.ok && view.file.kind === 'text' && view.file.truncated
  const markdown = contents !== null && isMarkdownFile(path)

  const read = useCallback(() => {
    const connection = app.connections.connection(hostId)
    if (!connection) return
    connection.api.readProjectFile(projectContext(projectPath, app.account.organizationId), { path, cwd: projectPath }).then(
      (file) => setView({ kind: 'loaded', file }),
      (cause: unknown) => setView({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) }),
    )
  }, [app, hostId, path, projectPath])

  useEffect(() => {
    if (phase === 'connected') read()
  }, [phase, read])

  useLayoutEffect(() => {
    const actions = [
      ...(markdown ? [{ id: 'markdown-mode', title: markdownMode === 'preview' ? 'Show source' : 'Show preview', image: markdownMode === 'preview' ? 'chevron.left.forwardslash.chevron.right' : 'doc.text' }] : []),
      { id: 'word-wrap', title: appearance.codeWordBreak ? 'Disable word wrap' : 'Enable word wrap', image: 'text.alignleft' },
      { id: 'copy-path', title: 'Copy path', image: 'doc.on.doc' },
      ...(contents !== null ? [{ id: 'copy-contents', title: truncated ? 'Copy preview' : 'Copy contents', image: 'doc.on.doc' }] : []),
    ]
    navigation.setOptions({
      title: path.slice(path.lastIndexOf('/') + 1),
      headerRight: () => (
        <ControlPillMenu
          accessibilityLabel="File actions"
          title="File actions"
          actions={actions}
          onPressAction={({ nativeEvent }) => {
            if (nativeEvent.event === 'markdown-mode') setMarkdownMode((mode) => (mode === 'preview' ? 'source' : 'preview'))
            else if (nativeEvent.event === 'word-wrap') setCodeWordBreak(!appearance.codeWordBreak)
            else if (nativeEvent.event === 'copy-path') copyTextWithHaptic(path)
            else if (nativeEvent.event === 'copy-contents' && contents !== null) copyTextWithHaptic(contents)
          }}
        >
          <Pressable accessibilityRole="button" accessibilityLabel="File actions" hitSlop={8} className="h-9 w-9 items-center justify-center">
            <SymbolView name="ellipsis" size={18} tintColorClassName="accent-icon" type="monochrome" />
          </Pressable>
        </ControlPillMenu>
      ),
    })
  }, [appearance.codeWordBreak, contents, markdown, markdownMode, navigation, path, setCodeWordBreak, truncated])

  if (view.kind === 'loading') {
    return (
      <View className="flex-1 bg-sheet">
        <HostStatusBanner hostId={hostId} />
        <FilePreviewLoading message="Loading file..." />
      </View>
    )
  }

  if (view.kind === 'error' || !view.file.ok || view.file.kind !== 'text') {
    const file = view.kind === 'loaded' ? view.file : null
    const detail = view.kind === 'error'
      ? view.message
      : file && !file.ok
        ? file.error
        : file && file.ok
          ? `${fileSizeLabel(file.size)}. This app cannot show this file; open it in Solus on your computer.`
          : ''
    const title = file?.ok && file.kind === 'media' ? 'Media file' : file?.ok ? 'Binary file' : 'File unavailable'
    const notice = (
      <View className="flex-1 items-center justify-center px-6">
        <EmptyState
          title={title}
          detail={detail}
          {...(view.kind === 'error' ? { actionLabel: 'Try again', onAction: read } : {})}
        />
      </View>
    )
    const mediaView = file?.ok ? fileMediaView(file.path) : null
    return (
      <View className="flex-1 bg-sheet">
        <HostStatusBanner hostId={hostId} />
        {file?.ok && mediaView
          ? <HostFileMedia hostId={hostId} projectPath={projectPath} path={file.path} view={mediaView} fallback={notice} />
          : notice}
      </View>
    )
  }

  return (
    <View className="flex-1 bg-sheet">
      <HostStatusBanner hostId={hostId} />
      {view.file.truncated ? (
        <FilePreviewNotice title="Partial file">{`Showing the start of a ${fileSizeLabel(view.file.size)} file.`}</FilePreviewNotice>
      ) : null}
      {markdown && markdownMode === 'preview' ? (
        <FileMarkdownPreview
          hostId={hostId}
          projectPath={projectPath}
          markdown={view.file.contents}
          path={path}
          onOpenFile={(target) => navigation.push('File', { hostId, projectPath, path: target })}
          onRefresh={read}
        />
      ) : (
        <SourceFileSurface contents={view.file.contents} path={path} onRefresh={read} />
      )}
    </View>
  )
}

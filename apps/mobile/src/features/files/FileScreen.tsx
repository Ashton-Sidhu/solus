import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { ActivityIndicator, FlatList, RefreshControl, ScrollView, Text, View } from 'react-native'
import type { FilePreviewResult } from '@solus/contracts/types'
import { useApp, useListened } from '../../app/app-context'
import type { ScreenProps } from '../../navigation/routes'
import { usePalette } from '../../theme/theme'
import { CODE_FONT, space } from '../../theme/tokens'
import { Banner, Button, EmptyState } from '../../ui/primitives'
import { HostStatusBanner } from '../hosts/HostStatusBanner'
import { projectContext } from '../conversation/lib/ipc-context'
import { fileSizeLabel } from './lib/file-tree'

type FileView =
  | { kind: 'loading' }
  | { kind: 'loaded'; file: FilePreviewResult }
  | { kind: 'error'; message: string }

/**
 * One file, read-only, with line numbers. Lines are list rows, so a long file
 * renders only what is on screen; the code scrolls sideways as a whole.
 */
export function FileScreen({ navigation, route }: ScreenProps<'File'>) {
  const { hostId, projectPath, path } = route.params
  const app = useApp()
  const palette = usePalette()
  const phase = useListened(app.connections.changes, () => app.connections.state(hostId)?.phase)
  const [view, setView] = useState<FileView>({ kind: 'loading' })

  useLayoutEffect(() => {
    navigation.setOptions({ title: path.slice(path.lastIndexOf('/') + 1) })
  }, [navigation, path])

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

  const lines = useMemo(() => (view.kind === 'loaded' && view.file.ok && view.file.kind === 'text' ? view.file.contents.split('\n') : []), [view])
  const gutter = String(lines.length).length

  if (view.kind !== 'loaded' || !view.file.ok || view.file.kind !== 'text') {
    return (
      <View style={{ flex: 1, backgroundColor: palette.canvas }}>
        <HostStatusBanner hostId={hostId} />
        {view.kind === 'loading' ? <View style={{ padding: space.xl }}><ActivityIndicator accessibilityLabel="Reading the file" /></View> : null}
        {view.kind === 'error' ? <View style={{ padding: space.lg }}><Banner message={`The file could not be read: ${view.message}`} action={<Button label="Try again" onPress={read} />} /></View> : null}
        {view.kind === 'loaded' && !view.file.ok ? <View style={{ padding: space.lg }}><Banner message={view.file.error} /></View> : null}
        {view.kind === 'loaded' && view.file.ok && view.file.kind !== 'text' ? (
          <EmptyState
            title={view.file.kind === 'media' ? 'Media file' : 'Binary file'}
            message={`${fileSizeLabel(view.file.size)}. This app shows text files only; open it in Solus on your computer.`}
          />
        ) : null}
      </View>
    )
  }

  return (
    <View style={{ flex: 1, backgroundColor: palette.card }}>
      {view.file.truncated ? (
        <Text style={{ paddingHorizontal: 17.5, paddingVertical: 8, color: palette.textTertiary, fontSize: 13, backgroundColor: palette.canvas }}>
          Showing the start of a {fileSizeLabel(view.file.size)} file.
        </Text>
      ) : null}
      <ScrollView horizontal contentInsetAdjustmentBehavior="automatic" style={{ flex: 1 }}>
        <FlatList
          contentInsetAdjustmentBehavior="automatic"
          data={lines}
          keyExtractor={(_line, index) => String(index)}
          initialNumToRender={60}
          refreshControl={<RefreshControl refreshing={false} onRefresh={read} />}
          contentContainerStyle={{ paddingVertical: 8 }}
          renderItem={({ item, index }) => (
            <View style={{ flexDirection: 'row' }}>
              <Text accessible={false} style={{ width: gutter * 8 + 20, paddingRight: 10, textAlign: 'right', color: palette.textTertiary, fontSize: 12, lineHeight: 20, fontFamily: CODE_FONT }}>{index + 1}</Text>
              <Text selectable style={{ paddingRight: 17.5, color: palette.text, fontSize: 12, lineHeight: 20, fontFamily: CODE_FONT }}>{item || ' '}</Text>
            </View>
          )}
        />
      </ScrollView>
    </View>
  )
}

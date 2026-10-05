import { ActionSheetIOS, ActivityIndicator, Alert, Platform, Pressable, ScrollView, Text, View } from 'react-native'
import * as DocumentPicker from 'expo-document-picker'
import * as ImagePicker from 'expo-image-picker'
import { MAX_ATTACHMENT_UPLOAD_COUNT } from '@solus/contracts/rpc'
import { usePalette } from '../../../theme/theme'
import { radius, space, TOUCH_TARGET, type } from '../../../theme/tokens'
import type { ConversationMeta, ConversationStore } from '../conversation-store'
import type { PickedFile } from '../lib/attachments'

/** Opens the photo library or the file picker; the picked files upload now. */
export function AttachButton({ store, meta, disabled }: { store: ConversationStore; meta: ConversationMeta; disabled: boolean }) {
  const palette = usePalette()
  const room = MAX_ATTACHMENT_UPLOAD_COUNT - meta.attachments.length - meta.uploading

  const pickMedia = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'], allowsMultipleSelection: true, selectionLimit: room, quality: 1 })
    if (result.canceled) return
    void store.controller.attach(result.assets.map((asset): PickedFile => ({
      uri: asset.uri,
      name: asset.fileName ?? asset.uri.split('/').pop() ?? 'attachment',
      mimeType: asset.mimeType ?? null,
      size: asset.fileSize ?? null,
    })))
  }
  const pickFiles = async () => {
    const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true })
    if (result.canceled) return
    void store.controller.attach(result.assets.map((asset): PickedFile => ({ uri: asset.uri, name: asset.name, mimeType: asset.mimeType ?? null, size: asset.size ?? null })))
  }
  const choose = () => {
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions({ options: ['Photos and videos', 'Files', 'Cancel'], cancelButtonIndex: 2 }, (index) => {
        if (index === 0) void pickMedia()
        if (index === 1) void pickFiles()
      })
    } else {
      Alert.alert('Attach', undefined, [
        { text: 'Photos and videos', onPress: () => void pickMedia() },
        { text: 'Files', onPress: () => void pickFiles() },
        { text: 'Cancel', style: 'cancel' },
      ])
    }
  }
  const unavailable = disabled || room <= 0
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Attach files"
      accessibilityState={{ disabled: unavailable }}
      disabled={unavailable}
      onPress={choose}
      style={{ minWidth: TOUCH_TARGET, minHeight: TOUCH_TARGET, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', opacity: unavailable ? 0.4 : 1 }}
    >
      <Text style={{ color: palette.accent, fontSize: 22, fontWeight: '500' }}>+</Text>
    </Pressable>
  )
}

/** The attachments the next prompt carries, each removable. */
export function AttachmentChips({ store, meta }: { store: ConversationStore; meta: ConversationMeta }) {
  const palette = usePalette()
  if (meta.attachments.length === 0 && meta.uploading === 0) return null
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: space.lg, gap: space.sm, alignItems: 'center' }}>
      {meta.attachments.map((attachment) => (
        <View key={attachment.id} style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs, borderRadius: radius.md, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.card, paddingLeft: space.sm }}>
          <Text numberOfLines={1} style={{ maxWidth: 160, color: palette.text, fontSize: type.dense }}>{attachment.name}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${attachment.name}`} onPress={() => store.controller.removeAttachment(attachment.id)} style={{ minWidth: TOUCH_TARGET, minHeight: 36, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ color: palette.textTertiary, fontSize: type.chrome }}>✕</Text>
          </Pressable>
        </View>
      ))}
      {meta.uploading > 0 ? <ActivityIndicator accessibilityLabel={`Uploading ${meta.uploading} attachments`} /> : null}
    </ScrollView>
  )
}

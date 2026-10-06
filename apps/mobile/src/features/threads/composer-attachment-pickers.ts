import * as DocumentPicker from 'expo-document-picker'
import * as ImagePicker from 'expo-image-picker'
import { MAX_ATTACHMENT_UPLOAD_COUNT } from '@solus/contracts/rpc'
import type { PickedFile } from '../conversation/lib/attachments'

/**
 * The two pickers behind T3's attachment button ("Photo Library", "Choose
 * Files"), answering the files as the Solus attachment upload reads them.
 * `existingCount` counts attachments already on the draft or uploading.
 */
export async function pickComposerMedia(existingCount: number): Promise<PickedFile[]> {
  const room = MAX_ATTACHMENT_UPLOAD_COUNT - existingCount
  if (room <= 0) return []
  const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'], allowsMultipleSelection: true, selectionLimit: room, quality: 1 })
  if (result.canceled) return []
  return result.assets.map((asset) => ({
    uri: asset.uri,
    name: asset.fileName ?? asset.uri.split('/').pop() ?? 'attachment',
    mimeType: asset.mimeType ?? null,
    size: asset.fileSize ?? null,
  }))
}

export async function pickComposerFiles(existingCount: number): Promise<PickedFile[]> {
  if (MAX_ATTACHMENT_UPLOAD_COUNT - existingCount <= 0) return []
  const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true })
  if (result.canceled) return []
  return result.assets.map((asset) => ({ uri: asset.uri, name: asset.name, mimeType: asset.mimeType ?? null, size: asset.size ?? null }))
}

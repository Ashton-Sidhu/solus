import * as DocumentPicker from 'expo-document-picker'
import { File } from 'expo-file-system'
import * as ImagePicker from 'expo-image-picker'
import { mimeTypeFor } from '@solus/contracts/media-types'
import { MAX_ATTACHMENT_UPLOAD_COUNT } from '@solus/contracts/rpc'
import type { PickedFile } from '../conversation/lib/attachments'

/**
 * The sources behind T3's attachment button ("Photo Library" and "Choose
 * Files") and pasted images, answering the files as the Solus attachment upload reads them.
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

/** Images pasted into the composer (local files), cut to the room left on the draft. */
export function pastedComposerImages(uris: string[]): (existingCount: number) => Promise<PickedFile[]> {
  return async (existingCount) =>
    uris.slice(0, Math.max(0, MAX_ATTACHMENT_UPLOAD_COUNT - existingCount)).map((uri) => {
      const name = decodeURIComponent(uri.split('/').pop() ?? 'pasted-image')
      return { uri, name, mimeType: mimeTypeFor(name) ?? null, size: new File(uri).size }
    })
}

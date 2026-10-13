import * as Clipboard from 'expo-clipboard'
import * as DocumentPicker from 'expo-document-picker'
import { Directory, File, Paths } from 'expo-file-system'
import * as ImagePicker from 'expo-image-picker'
import { MAX_ATTACHMENT_UPLOAD_COUNT } from '@solus/contracts/rpc'
import type { PickedFile } from '../conversation/lib/attachments'

/**
 * The sources behind T3's attachment button ("Photo Library", "Choose
 * Files", and "Paste Image"), answering the files as the Solus attachment upload reads them.
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

/**
 * The composer's text field takes only text from the clipboard, so a copied
 * image arrives through the attachment menu instead. The image is written to
 * the cache because the upload reads files, not data URLs.
 */
export async function pickComposerClipboardImage(existingCount: number): Promise<PickedFile[]> {
  if (MAX_ATTACHMENT_UPLOAD_COUNT - existingCount <= 0) return []
  const image = await Clipboard.getImageAsync({ format: 'png' })
  if (!image) throw new Error('The clipboard has no image.')
  const directory = new Directory(Paths.cache, 'solus-clipboard-images')
  directory.create({ idempotent: true, intermediates: true })
  const name = `pasted-image-${Date.now()}.png`
  const file = new File(directory, name)
  file.create()
  file.write(image.data.slice(image.data.indexOf(',') + 1), { encoding: 'base64' })
  return [{ uri: file.uri, name, mimeType: 'image/png', size: file.size }]
}

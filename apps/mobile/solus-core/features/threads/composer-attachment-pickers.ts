import * as DocumentPicker from 'expo-document-picker'
import { File } from 'expo-file-system'
import * as ImagePicker from 'expo-image-picker'
import { mimeTypeFor } from '@solus/contracts/media-types'
import type { PickedFile } from '../conversation/lib/attachments'
import { openComposerMediaLibrary } from '../../../src/lib/composerMediaLibrary'

/**
 * The sources behind T3's attachment button ("Photo Library" and "Choose
 * Files") and pasted images, answering the files as the Solus attachment upload reads them.
 */
export async function pickComposerMedia(): Promise<PickedFile[]> {
  const result = await openComposerMediaLibrary(ImagePicker.launchImageLibraryAsync, { allowVideos: true })
  if (result.canceled) return []
  return result.assets.map((asset) => ({
    uri: asset.uri,
    name: asset.fileName ?? asset.uri.split('/').pop() ?? 'attachment',
    mimeType: asset.mimeType ?? null,
    size: asset.fileSize ?? new File(asset.uri).size,
  }))
}

export async function pickComposerFiles(): Promise<PickedFile[]> {
  const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true })
  if (result.canceled) return []
  return result.assets.map((asset) => ({ uri: asset.uri, name: asset.name, mimeType: asset.mimeType ?? null, size: asset.size ?? null }))
}

/** Images pasted into the composer as local files. */
export async function pastedComposerImages(uris: readonly string[]): Promise<PickedFile[]> {
  return uris.map((uri) => {
    const name = decodeURIComponent(uri.split('/').pop() ?? 'pasted-image')
    return { uri, name, mimeType: mimeTypeFor(name) ?? null, size: new File(uri).size }
  })
}

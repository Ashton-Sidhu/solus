import * as DocumentPicker from 'expo-document-picker'
import { File } from 'expo-file-system'
import * as ImagePicker from 'expo-image-picker'
import { isHeicFile, mimeTypeFor } from '@solus/contracts/media-types'
import { GENERIC_MIME_TYPES, imageMimeType } from '@t3tools/shared/image'
import { videoMimeType } from '@t3tools/shared/video'
import type { PickedFile } from '../conversation/lib/attachments'
import { renderPhoto } from '../../../src/lib/composerImageFit'
import { openComposerMediaLibrary } from '../../../src/lib/composerMediaLibrary'

function pickedMediaMimeType(name: string, mimeType: string) {
  return videoMimeType({ name, mimeType }) ?? imageMimeType({ name, mimeType })
}

async function prepareJpeg(uri: string, name: string): Promise<PickedFile> {
  const photo = await renderPhoto(uri)
  return {
    uri: photo.uri,
    name: `${name.replace(/\.[^.]+$/, '')}.jpg`,
    mimeType: 'image/jpeg',
    size: new File(photo.uri).size,
  }
}

async function preparePickedFile(file: PickedFile): Promise<PickedFile> {
  if (!isHeicFile(file)) return file
  try {
    return await prepareJpeg(file.uri, file.name)
  } catch {
    // The host may be able to convert a photo that this device cannot decode.
    return file
  }
}

/**
 * The sources behind T3's attachment button ("Photo Library" and "Choose
 * Files") and pasted images, answering the files as the Solus attachment upload reads them.
 */
export async function pickComposerMedia(): Promise<PickedFile[]> {
  const result = await openComposerMediaLibrary(ImagePicker.launchImageLibraryAsync, { allowVideos: true })
  if (result.canceled) return []
  const files: PickedFile[] = []
  for (const asset of result.assets) {
    const file = new File(asset.uri)
    const localName = file.name || asset.uri.split('/').pop() || 'attachment'
    let name = asset.fileName?.trim() || localName
    const reportedMime = asset.mimeType?.trim().toLowerCase() ?? ''
    const mime = !reportedMime || GENERIC_MIME_TYPES.has(reportedMime)
      ? file.type.trim().toLowerCase() || reportedMime
      : reportedMime
    const mimeType = pickedMediaMimeType(name, mime) ?? pickedMediaMimeType(localName, mime) ?? mime
    if (
      isHeicFile({ name, mimeType }) || isHeicFile({ name: localName, mimeType }) ||
      (asset.type === 'image' && (!mimeType || GENERIC_MIME_TYPES.has(mimeType)))
    ) {
      files.push(await prepareJpeg(asset.uri, name))
      continue
    }
    // Keep a video extension so saved messages can recover its preview from the host path.
    const localVideoMime = videoMimeType({ name: localName, mimeType: '' })
    if (localVideoMime === mimeType && videoMimeType({ name, mimeType: '' }) === null) {
      name += localName.slice(localName.lastIndexOf('.'))
    }
    files.push({ uri: asset.uri, name, mimeType: mimeType || null, size: asset.fileSize ?? file.size })
  }
  return files
}

export async function pickComposerFiles(): Promise<PickedFile[]> {
  const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true })
  if (result.canceled) return []
  const files: PickedFile[] = []
  for (const asset of result.assets) {
    files.push(await preparePickedFile({
      uri: asset.uri,
      name: asset.name,
      mimeType: pickedMediaMimeType(asset.name, asset.mimeType ?? '') ?? asset.mimeType ?? null,
      size: asset.size ?? null,
    }))
  }
  return files
}

/** Images pasted into the composer as local files. */
export async function pastedComposerImages(uris: readonly string[]): Promise<PickedFile[]> {
  const files: PickedFile[] = []
  for (const uri of uris) {
    const name = decodeURIComponent(uri.split('/').pop() ?? 'pasted-image')
    const file = new File(uri)
    files.push(await preparePickedFile({ uri, name, mimeType: mimeTypeFor(name) ?? (file.type || null), size: file.size }))
  }
  return files
}

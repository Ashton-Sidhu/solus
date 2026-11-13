import * as DocumentPicker from 'expo-document-picker'
import { File } from 'expo-file-system'
import { EncodingType, readAsStringAsync } from 'expo-file-system/legacy'
import * as Sharing from 'expo-sharing'
import type { AppSavedFile } from '@solus/client-core/app-calls'
import { createCachedAttachmentFile } from '../../lib/attachmentDownload'
import { deviceFileSource, type DeviceFile } from './app-file-source'

/**
 * App files on the device (docs/plans/apps.md §5, §9.3): the phone's file
 * chooser for an upload, and the share sheet for a file the person takes out
 * of an app. A file crosses in parts of base64, so its bytes go between the
 * disk and the host without one string that holds all of them.
 */

/** Opens the phone's file chooser. Answers the chosen file, or null when the person chose none. */
export async function pickDeviceFile(): Promise<DeviceFile | null> {
  // The chooser can give a provider's address; a copy in the cache is a file the range read can open.
  const result = await DocumentPicker.getDocumentAsync({ multiple: false, copyToCacheDirectory: true })
  const asset = result.canceled ? undefined : result.assets[0]
  if (!asset) return null
  return { uri: asset.uri, name: asset.name, type: asset.mimeType ?? '', size: asset.size ?? new File(asset.uri).size }
}

/** A chosen file as a source the shared upload reads from disk, one part at a time. */
export function pickedFileSource(file: DeviceFile) {
  return deviceFileSource(file, (uri, offset, length) => readAsStringAsync(uri, { encoding: EncodingType.Base64, position: offset, length }))
}

/**
 * Writes a file's parts of base64 to the cache and opens the share sheet for
 * it, where the person saves it, opens it in another app, or sends it. The
 * cached copy stays for a day: a receiver can still read it after the sheet
 * closes.
 */
export async function shareFileParts(file: { readonly name: string; readonly type: string }, parts: readonly string[]): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) throw new Error('Saving and sharing files is unavailable on this device.')
  const cached = await createCachedAttachmentFile({ name: file.name, mimeType: file.type })
  try {
    cached.file.create()
    for (const part of parts) cached.file.write(part, { encoding: 'base64', append: true })
    await Sharing.shareAsync(cached.file.uri, { mimeType: file.type || 'application/octet-stream', dialogTitle: file.name })
    cached.retain()
  } finally {
    cached.dispose()
  }
}

/** What this client does for `@client/save`: it gives the person the file through the share sheet. */
export function saveAppFile(file: AppSavedFile): Promise<void> {
  return shareFileParts(file, [file.data])
}

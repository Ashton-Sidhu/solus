import type { AppFileView } from '@solus/contracts/apps'
import { appFileRefusal, blobFileSource, blobFromParts, readAppFileParts, uploadAppFile, type AppHostCall } from '@solus/client-core/app-files'
import { downloadBlob } from '../../../work/lib/work-export'

/**
 * The Files section (docs/plans/apps.md §9.2): a file goes to the app and
 * comes back in parts, over the same `@files` names the app's UI uses.
 */

/** One file on its way to the app. */
export interface FileUpload {
  name: string
  size: number
  sentBytes: number
  /** Why the file did not become an app file; null while it goes and when it is done. */
  error: string | null
}

/** How much of an upload is sent, from 0 to 100. A file of no bytes is done when it starts. */
export function uploadPercent(upload: Pick<FileUpload, 'size' | 'sentBytes'>): number {
  return upload.size === 0 ? 100 : Math.min(100, Math.round((upload.sentBytes / upload.size) * 100))
}

/** Why the browser's file cannot be an app file, before a byte is sent; null when it can. */
export function uploadRefusal(file: Pick<File, 'size'>): string | null {
  return appFileRefusal(file.size)
}

/** Sends one file of the browser to the app. `onProgress` hears the bytes sent so far. */
export function uploadFile(call: AppHostCall, file: File, onProgress: (sentBytes: number) => void): Promise<AppFileView> {
  return uploadAppFile(call, blobFileSource(file, file.name), onProgress)
}

/** Reads one app file from its host and gives it to the person as a browser download. */
export async function downloadFile(call: AppHostCall, file: Pick<AppFileView, 'id' | 'name' | 'type'>): Promise<void> {
  downloadBlob(file.name, blobFromParts(await readAppFileParts(call, file.id), file.type))
}

const CREATED_BY_LABELS = {
  ui: 'Uploaded',
  agent: 'An agent',
  schedule: 'A schedule',
  webhook: 'A webhook',
  workflow: 'A workflow',
  model: 'A model call',
} satisfies { [Kind in AppFileView['createdBy']]: string }

/** Who made a file: a person in a UI, or the backend for one of its callers. */
export function fileCreatedByText(createdBy: AppFileView['createdBy']): string {
  return CREATED_BY_LABELS[createdBy]
}

export function fileDeleteConfirmText(name: string): string {
  return `Delete the file "${name}"? The app can no longer read it. You cannot get it back.`
}

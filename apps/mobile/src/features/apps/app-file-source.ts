import type { AppFileSource } from '@solus/client-core/app-files'
import type { AppCallerKind, AppFileView } from '@solus/contracts/apps'
import type { RowLine } from '../webhooks/webhook-rows'
import { agoText, bytesText } from './apps'

/**
 * The Files section (docs/plans/apps.md §4.3, §9.2) in plain terms: a file on
 * the phone as a source the shared upload reads in parts, and the words of
 * the list. The device calls are in `app-device-files.ts`.
 */

/** A file the person chose on the phone. */
export interface DeviceFile {
  readonly uri: string
  readonly name: string
  /** The media type; empty when the phone did not say. */
  readonly type: string
  readonly size: number
}

/** Reads `length` bytes of the file at `uri` from `offset`, as base64. */
export type FileRangeReader = (uri: string, offset: number, length: number) => Promise<string>

/**
 * A file on the phone as a file a client can send. The phone has no `Blob`
 * of the file, so each part is read from disk when the upload asks for it,
 * and the file is never in memory as a whole.
 */
export function deviceFileSource(file: DeviceFile, readRange: FileRangeReader): AppFileSource {
  return {
    name: file.name,
    type: file.type,
    size: file.size,
    part: (offset, length) => readRange(file.uri, offset, length),
  }
}

/** An upload in progress. */
export interface FileUpload {
  readonly name: string
  readonly sentBytes: number
  readonly size: number
}

/** What the Files section says while a file goes to the host. */
export function uploadProgressText(upload: FileUpload): string {
  const percent = upload.size === 0 ? 100 : Math.min(100, Math.floor((upload.sentBytes / upload.size) * 100))
  return `Uploading ${upload.name}: ${percent}% of ${bytesText(upload.size)}`
}

/** Who made a file: a person in the UI, or the backend for one of its callers. */
function madeByText(kind: AppCallerKind): string {
  switch (kind) {
    case 'ui': return 'uploaded by a person'
    case 'agent': return 'written for an agent'
    case 'schedule': return 'written for a schedule'
    case 'webhook': return 'written for a webhook'
    case 'workflow': return 'written by a workflow'
    case 'model': return 'written for a model call'
  }
}

/** The lines of one app file: its type, when it was made, and who made it. */
export function fileLines(file: AppFileView, now: number): RowLine[] {
  return [{ text: file.type }, { text: `${agoText(file.createdAt, now)} · ${madeByText(file.createdBy)}` }]
}

/** The newest file first; the same instant keeps a stable order by id. */
export function sortFiles(files: readonly AppFileView[]): AppFileView[] {
  return [...files].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
}

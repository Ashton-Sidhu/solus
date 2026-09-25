import type { Attachment } from '@solus/contracts/types'
import type { BrowserPage, BrowserRecordingRef } from '@solus/contracts/browser-types'

/**
 * Browser recordings, taken apart for display.
 *
 * The host owns a recording: whether one runs is `page.recording`, and a
 * finished one is a `BrowserRecordingRef`. What is here is how the toolbar,
 * the conversation card, and the composer say it, so the three agree.
 */

/** `m:ss`. A recording is at most five minutes, so minutes never need a pad. */
export function recordingClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/** `mm:ss`, for the toolbar's running time: a fixed width does not move the
 *  controls beside it as the time goes past a minute. */
export function recordingElapsed(startedAt: number, now: number): string {
  return recordingClock(now - startedAt).padStart(5, '0')
}

/** Megabytes with one decimal. A very short recording still reads as a size,
 *  not as `0.0 MB`. */
export function recordingSize(bytes: number): string {
  return `${Math.max(0.1, bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Why a recording ended before a stop, as a sentence. Null when it was
 *  stopped on purpose, which needs no explanation. */
export function recordingStopNote(recording: BrowserRecordingRef): string | null {
  switch (recording.stoppedBy) {
    case 'duration-limit': return 'Stopped at the 5-minute limit'
    case 'size-limit': return 'Stopped at the 50 MB limit'
    case 'page-closed': return 'Stopped when the page closed'
    default: return null
  }
}

/** The page's own name, then its address. A recording always has a title. */
export function recordingTitle(recording: BrowserRecordingRef): string {
  return recording.title || recording.url || 'Browser'
}

/** The line beside the card's title: the device, the length, the size. */
export function recordingCaption(recording: BrowserRecordingRef): string {
  return [
    recording.viewport,
    recordingClock(recording.durationMs),
    recordingSize(recording.sizeBytes),
  ].filter(Boolean).join(' · ')
}

/** Stable for one recording, so attaching it twice replaces the chip. */
export function recordingAttachmentId(assetId: string): string {
  return `browser-recording:${assetId}`
}

function fileStamp(at: number): string {
  const date = new Date(at)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/**
 * The composer attachment for a finished recording.
 *
 * The file is already on the host, so nothing is uploaded: the attachment
 * carries the host path and the host that owns it, the same shape a video the
 * user dropped in has after its upload.
 */
export function recordingAttachment(serverId: string, recording: BrowserRecordingRef): Attachment {
  return {
    id: recordingAttachmentId(recording.assetId),
    type: 'file',
    name: `recording-${fileStamp(recording.capturedAt)}.mp4`,
    mimeType: 'video/mp4',
    path: recording.hostPath,
    hostPath: recording.hostPath,
    hostServerId: serverId,
    size: recording.sizeBytes,
  }
}

/** Add a recording to a composer once. Returns false when it is already there:
 *  a stop and a limit can both answer for one recording. */
export function addRecordingAttachment(
  attachments: Attachment[],
  serverId: string,
  recording: BrowserRecordingRef,
): boolean {
  const attachment = recordingAttachment(serverId, recording)
  if (attachments.some((candidate) => candidate.id === attachment.id)) return false
  attachments.push(attachment)
  return true
}

export type RecordControl =
  | { kind: 'idle'; disabledReason: string | null }
  | { kind: 'recording'; label: string; startedAt: number; isStopping: boolean }

/**
 * What the toolbar's record control shows.
 *
 * Stop is never gated on the host's capability or on DevTools: a recording
 * that runs must always have a way out, whoever started it.
 */
export function recordControl(input: {
  page: Pick<BrowserPage, 'recording' | 'devToolsOpen'>
  /** `undefined` while the host's capabilities load. */
  canRecord: boolean | undefined
  request: 'starting' | 'stopping' | null
}): RecordControl {
  const { page, canRecord, request } = input
  if (page.recording) {
    return {
      kind: 'recording',
      label: page.recording.startedBy === 'agent' ? 'Agent is recording' : 'Recording',
      startedAt: page.recording.startedAt,
      isStopping: request === 'stopping',
    }
  }
  let disabledReason: string | null = null
  if (canRecord === undefined) disabledReason = 'Checking whether this host can record'
  else if (!canRecord) {
    disabledReason = 'This host cannot record browser pages. Install the browser runtime on the host, or update it.'
  } else if (page.devToolsOpen) disabledReason = 'Close DevTools to record this page'
  else if (request === 'starting') disabledReason = 'Starting the recording'
  else if (request === 'stopping') disabledReason = 'Saving the recording'
  return { kind: 'idle', disabledReason }
}

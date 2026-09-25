import { describe, expect, test } from 'bun:test'
import type { BrowserRecordingRef } from '@solus/contracts/browser-types'
import type { Attachment, Message } from '@solus/contracts/types'
import {
  addRecordingAttachment,
  recordControl,
  recordingCaption,
  recordingClock,
  recordingElapsed,
  recordingSize,
  recordingStopNote,
  recordingTitle,
} from '@solus/workspace-ui/components/browser/lib/recording'
import { groupMessages } from '@solus/workspace-ui/components/conversation/lib/turns'

function recording(overrides: Partial<BrowserRecordingRef> = {}): BrowserRecordingRef {
  return {
    browserPageId: 'page-1',
    assetId: `${'a'.repeat(64)}.mp4`,
    hostPath: '/host/assets/recording.mp4',
    url: 'http://localhost:5173/checkout',
    title: 'Checkout',
    viewport: 'iPhone 15 — 393×852',
    durationMs: 72_400,
    sizeBytes: 3_250_000,
    capturedAt: Date.UTC(2026, 8, 24, 10, 5, 9),
    ...overrides,
  }
}

describe('recording times and sizes', () => {
  test('a duration reads as m:ss and never goes negative', () => {
    expect(recordingClock(72_400)).toBe('1:12')
    expect(recordingClock(5_000)).toBe('0:05')
    // WHY: host and client clocks can differ a little; a running time must not
    // start at a negative number.
    expect(recordingClock(-400)).toBe('0:00')
  })

  test('the toolbar time keeps a fixed width across the first minute', () => {
    // WHY: the controls beside the time must not move each second.
    expect(recordingElapsed(1_000, 8_000)).toBe('00:07')
    expect(recordingElapsed(1_000, 1_000 + 4 * 60_000 + 59_000)).toBe('04:59')
  })

  test('a very short recording still states a size', () => {
    expect(recordingSize(3_250_000)).toBe('3.1 MB')
    expect(recordingSize(20_000)).toBe('0.1 MB')
  })
})

describe('recording card', () => {
  test('the caption names the device, the length, and the size', () => {
    expect(recordingCaption(recording())).toBe('iPhone 15 — 393×852 · 1:12 · 3.1 MB')
  })

  test('a recording a limit ended says why; a stop needs no note', () => {
    expect(recordingStopNote(recording())).toBeNull()
    expect(recordingStopNote(recording({ stoppedBy: 'duration-limit' }))).toBe('Stopped at the 5-minute limit')
    expect(recordingStopNote(recording({ stoppedBy: 'size-limit' }))).toBe('Stopped at the 50 MB limit')
    expect(recordingStopNote(recording({ stoppedBy: 'page-closed' }))).toBe('Stopped when the page closed')
  })

  test('a recording always has a title', () => {
    expect(recordingTitle(recording({ title: '' }))).toBe('http://localhost:5173/checkout')
    expect(recordingTitle(recording({ title: '', url: '' }))).toBe('Browser')
  })

  test('an agent recording becomes its own transcript item', () => {
    const messages: Message[] = [
      { id: 'r1', role: 'assistant', content: '', browserRecording: recording(), timestamp: 1 },
    ]
    expect(groupMessages(messages)).toEqual([{ kind: 'browser-recording', message: messages[0] }])
  })
})

describe('recording composer attachment', () => {
  test('attaches the host file as a video without an upload', () => {
    const attachments: Attachment[] = []
    expect(addRecordingAttachment(attachments, 'host-a', recording())).toBe(true)
    // WHY: the agent reads the host path; the chip plays a video file. The
    // host id keeps the path from being sent to another machine.
    expect(attachments[0]).toMatchObject({
      type: 'file',
      mimeType: 'video/mp4',
      path: '/host/assets/recording.mp4',
      hostPath: '/host/assets/recording.mp4',
      hostServerId: 'host-a',
      size: 3_250_000,
    })
    expect(attachments[0]!.name).toMatch(/^recording-\d{8}-\d{6}\.mp4$/)
  })

  test('one recording is attached once', () => {
    const attachments: Attachment[] = []
    addRecordingAttachment(attachments, 'host-a', recording())
    // WHY: a stop and a limit can both answer for one recording.
    expect(addRecordingAttachment(attachments, 'host-a', recording())).toBe(false)
    expect(attachments).toHaveLength(1)
  })
})

describe('record control', () => {
  const idle = { recording: null, devToolsOpen: false }

  test('offers Record only where the host can record and DevTools are closed', () => {
    expect(recordControl({ page: idle, canRecord: true, request: null })).toEqual({ kind: 'idle', disabledReason: null })
    expect(recordControl({ page: idle, canRecord: false, request: null }).kind).toBe('idle')
    expect(recordControl({ page: idle, canRecord: false, request: null })).not.toMatchObject({ disabledReason: null })
    expect(recordControl({ page: { ...idle, devToolsOpen: true }, canRecord: true, request: null }))
      .toEqual({ kind: 'idle', disabledReason: 'Close DevTools to record this page' })
    expect(recordControl({ page: idle, canRecord: undefined, request: null })).not.toMatchObject({ disabledReason: null })
  })

  test('a running recording can always be stopped, and says who started it', () => {
    const page = { recording: { startedAt: 10, startedBy: 'agent' as const }, devToolsOpen: true }
    // WHY: Stop is the way out. Neither the capability nor DevTools may hide it.
    expect(recordControl({ page, canRecord: false, request: null })).toEqual({
      kind: 'recording',
      label: 'Agent is recording',
      startedAt: 10,
      isStopping: false,
    })
    expect(recordControl({ page, canRecord: true, request: 'stopping' })).toMatchObject({ isStopping: true })
  })
})

import { Circle, Square } from '@lucide/svelte'
import type { BrowserEvidenceTarget, BrowserRecordingResult } from '@solus/contracts/browser-types'
import type { Attachment } from '@solus/contracts/types'
import { browserStore, type BrowserPageEntry } from '../../../contexts/browser/browser.store.svelte'
import { hostCapabilitiesStore } from '../../../contexts/connections/host-capabilities.store.svelte'
import { requestInputFocus } from '../../../lib/inputFocus'
import { comboHint } from '../../../lib/keybindings/manifest'
import { toasts } from '../../../lib/toasts'
import type { Command } from '../../command-palette/lib/commands'
import { addRecordingAttachment, recordingClock, recordingStopNote } from './recording'

/**
 * The record actions every entry point shares: the toolbar control, `⌥R` in
 * the pane, and the command palette. Each one says its own failure, and a stop
 * the user asked for returns focus to the composer the recording went to.
 */

function failed(action: string): (error: Error) => void {
  return (error) => void toasts.error(action, { description: error.message })
}

export function startPageRecording(entry: BrowserPageEntry): void {
  void browserStore
    .startRecording(entry.serverId, entry.page.browserPageId)
    .catch(failed("Couldn't start recording"))
}

/**
 * Stop and keep the recording. `focusComposer` returns typing to the composer
 * the recording went to: from the browser pane that is the leading pane, which
 * is not the focused one, so a plain focus request would reach no composer.
 */
export function stopPageRecording(
  entry: BrowserPageEntry,
  attach?: BrowserEvidenceTarget,
  focusComposer: () => void = requestInputFocus,
): void {
  void browserStore
    .stopRecording(entry.serverId, entry.page.browserPageId, attach)
    .then((result) => {
      if (result) focusComposer()
    })
    .catch(failed("Couldn't save the recording"))
}

/** Focus the leading pane's composer, where a stopped recording is attached. */
export function focusLeadingComposer(router: { leadingPane: { id: string }; focusPane(paneId: string): void }): void {
  router.focusPane(router.leadingPane.id)
  requestInputFocus()
}

export function togglePageRecording(entry: BrowserPageEntry, focusComposer?: () => void): void {
  if (entry.page.recording) stopPageRecording(entry, undefined, focusComposer)
  else if (hostCapabilitiesStore.supports(entry.serverId, 'browserRecording') && !entry.page.devToolsOpen) {
    startPageRecording(entry)
  }
}

/**
 * Put a saved recording on the composer and say what happened to it. The
 * shell installs this as `browserStore.onRecordingSaved`, so a stop from any
 * entry point, and a recording a limit ended, land in the same place.
 */
export function deliverRecording(
  composer: { attachments: Attachment[] },
  serverId: string,
  result: BrowserRecordingResult,
): void {
  addRecordingAttachment(composer.attachments, serverId, result.recording)
  const description = [recordingClock(result.recording.durationMs), recordingStopNote(result.recording)]
    .filter(Boolean)
    .join(' · ')
  if (result.attachError) {
    toasts.error('Recording attached, but not filed', { description: result.attachError })
    return
  }
  toasts.success(
    result.attachedTo ? `Recording attached — filed on ${result.attachedTo}` : 'Recording attached',
    { description },
  )
}

/** "Start recording" or "Stop recording" for the page the browser pane shows.
 *  Absent while no page is open, or when the host cannot record and nothing
 *  is recording. */
export function browserRecordingCommands(focusComposer?: () => void): Command[] {
  const entry = browserStore.activeEntry
  if (!entry) return []
  const hint = comboHint('browser-pane.toggle-recording')
  if (entry.page.recording) {
    return [{
      id: 'browser-stop-recording',
      label: 'Stop recording',
      group: 'Browser',
      icon: Square,
      hint,
      keywords: ['browser', 'record', 'video', 'screen', 'stop', 'save'],
      run: () => stopPageRecording(entry, undefined, focusComposer),
    }]
  }
  if (!hostCapabilitiesStore.supports(entry.serverId, 'browserRecording') || entry.page.devToolsOpen) return []
  return [{
    id: 'browser-start-recording',
    label: 'Start recording',
    group: 'Browser',
    icon: Circle,
    hint,
    keywords: ['browser', 'record', 'video', 'screen', 'capture'],
    run: () => startPageRecording(entry),
  }]
}

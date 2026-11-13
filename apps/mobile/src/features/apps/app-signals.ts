import type {
  AppSignalAction,
  AppSignalActionSaveRequest,
  AppSignalActionType,
  AppSignalActionView,
  AppSignalDelivery,
  AppSignalOccurrence,
  AppSignalView,
} from '@solus/contracts/apps'
import type { RowLine } from '../webhooks/webhook-rows'
import { agoText, countText, type Confirmation } from './apps'

/**
 * The Signals section (docs/plans/apps.md §8.4, §9.2): each signal the app
 * declares, what the owner made it do, and its newest occurrences. A signal
 * does nothing by itself (decision 24): its signal actions decide.
 */

/** The most occurrences one read gives. */
export const OCCURRENCE_LIMIT = 50

export function signalActionLabel(type: AppSignalActionType): string {
  switch (type) {
    case 'notify': return 'Notification'
    case 'send_to_session': return 'Prompt to a session'
    case 'run_automation': return 'Run of an automation'
  }
}

export const ACTION_MADE_ELSEWHERE_NOTE = 'An action that sends a prompt to a session or runs an automation is made on desktop or on the web. Here you turn it off, turn it on, or delete it.'
export const TEMPLATE_NOTE = 'A template takes {{payload.path}}, {{payload}}, {{signal}}, and {{app}}. An empty template gives the signal and its payload.'

function firstLine(text: string): string {
  return text.trim().split('\n', 1)[0] ?? ''
}

/** What an action sends when its template is empty. */
const EMPTY_TEMPLATE_LINE: RowLine = { text: 'Gives the signal and its payload' }

/** The lines of one signal action: the templates it renders, or what an empty template gives. */
export function signalActionLines(action: AppSignalAction): RowLine[] {
  if (action.type === 'notify') {
    const lines: RowLine[] = []
    if (action.title) lines.push({ text: `Title: ${firstLine(action.title)}` })
    if (action.detail) lines.push({ text: `Detail: ${firstLine(action.detail)}` })
    return lines.length > 0 ? lines : [EMPTY_TEMPLATE_LINE]
  }
  const template = firstLine(action.template)
  return [template ? { text: `Template: ${template}` } : EMPTY_TEMPLATE_LINE]
}

/** The lines of one signal: what it means, and how often the app emitted it. */
export function signalLines(signal: AppSignalView, now: number): RowLine[] {
  const lines: RowLine[] = signal.description ? [{ text: signal.description }] : []
  lines.push({
    text: signal.lastEmittedAt === null
      ? 'Not emitted yet'
      : `${countText(signal.count24h, 'occurrence')} in 24 h · last ${agoText(signal.lastEmittedAt, now)}`,
  })
  return lines
}

/** A `notify` action as the form holds it. `actionId` absent: a new action. */
export interface NotifyDraft {
  readonly signal: string
  readonly actionId?: string
  readonly enabled: boolean
  readonly title: string
  readonly detail: string
}

/** The form for a new `notify` action of a signal, turned on. */
export function newNotifyDraft(signal: string): NotifyDraft {
  return { signal, enabled: true, title: '', detail: '' }
}

/**
 * The form for a `notify` action that exists, or null for an action the
 * phone does not change. An action that starts agent work names a session or
 * an automation, and the phone has no picker for those: it shows such an
 * action, turns it off and on, and deletes it.
 */
export function notifyDraftOf(view: AppSignalActionView): NotifyDraft | null {
  if (view.action.type !== 'notify') return null
  return { signal: view.signal, actionId: view.id, enabled: view.enabled, title: view.action.title, detail: view.action.detail }
}

export function notifySaveRequest(appId: string, draft: NotifyDraft): AppSignalActionSaveRequest {
  const request: AppSignalActionSaveRequest = {
    appId,
    signal: draft.signal,
    enabled: draft.enabled,
    action: { type: 'notify', title: draft.title.trim(), detail: draft.detail.trim() },
  }
  if (draft.actionId) request.actionId = draft.actionId
  return request
}

/** The save that turns one action off or on. The action itself goes back as it is. */
export function enabledSaveRequest(appId: string, view: AppSignalActionView, enabled: boolean): AppSignalActionSaveRequest {
  return { appId, actionId: view.id, signal: view.signal, enabled, action: view.action }
}

export function deleteActionConfirmation(view: AppSignalActionView): Confirmation {
  return {
    title: `Delete this ${signalActionLabel(view.action.type).toLowerCase()}?`,
    message: `The signal ${view.signal} does not start it any more. You can add a notification again; an action that starts agent work is made on desktop or on the web.`,
  }
}

/** How one signal action ended for one occurrence. */
export function deliveryLine(delivery: AppSignalDelivery): RowLine {
  const label = signalActionLabel(delivery.type)
  switch (delivery.status) {
    case 'delivered': return { text: delivery.detail ? `${label}: ${delivery.detail}` : `${label}: delivered` }
    case 'failed': return { text: `${label} failed: ${delivery.detail ?? 'no reason given'}`, tone: 'danger' }
    // Decision 24: an action that starts agent work has a limit of starts in one hour.
    case 'throttled': return { text: `${label} did not run: it reached its limit of agent starts for the hour`, tone: 'danger' }
  }
}

/** The longest payload a row shows; the whole payload is on desktop and web. */
const PAYLOAD_PREVIEW_LENGTH = 160

/** The lines of one occurrence: the start of its payload, then how each action ended. */
export function occurrenceLines(occurrence: AppSignalOccurrence): RowLine[] {
  const payload = occurrence.payload.replace(/\s+/g, ' ')
  const preview = payload.length > PAYLOAD_PREVIEW_LENGTH ? `${payload.slice(0, PAYLOAD_PREVIEW_LENGTH)}…` : payload
  const deliveries = occurrence.deliveries.length === 0 ? [{ text: 'No action was on' }] : occurrence.deliveries.map(deliveryLine)
  return [{ text: preview }, ...deliveries]
}

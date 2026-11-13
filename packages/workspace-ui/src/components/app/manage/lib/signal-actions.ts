import { appSignalActionSchema, type AppSignalAction, type AppSignalActionType, type AppSignalActionView, type AppSignalDelivery, type AppSignalOccurrence } from '@solus/contracts/apps'
import type { DraftResult } from '../../../webhooks/lib/webhook-draft'

/**
 * The Signals section (docs/plans/apps.md §8.4, §9.2): the draft of one
 * signal action. Plain text fields with no defaults, as the webhook editor
 * has: a save never sends a value the owner did not choose.
 */

export interface SignalActionDraft {
  type: AppSignalActionType
  enabled: boolean
  /** The templates of a `notify` action. */
  title: string
  detail: string
  /** The prompt template of the two actions that start agent work. */
  template: string
  sessionId: string
  automationId: string
}

export const SIGNAL_ACTION_TYPES: readonly AppSignalActionType[] = ['notify', 'send_to_session', 'run_automation']

const ACTION_TYPE_LABELS = {
  notify: 'Notify me',
  send_to_session: 'Send to a session',
  run_automation: 'Run an automation',
} satisfies { [Type in AppSignalActionType]: string }

export function signalActionTypeLabel(type: AppSignalActionType): string {
  return ACTION_TYPE_LABELS[type]
}

/** What the owner reads under each template field. */
export const SIGNAL_TEMPLATE_HELP = 'A template takes {{payload.path}}, {{payload}}, {{signal}}, and {{app}}.'
/** What the owner reads under a prompt template. */
export const SIGNAL_EMPTY_TEMPLATE_TEXT = 'An empty template gives the signal and its payload.'
/** A signal that must start a new session runs an automation (§8.4). */
export const SIGNAL_NEW_SESSION_TEXT = 'To start a new session, run an automation: the automation holds the agent, the model, and the folder.'
/** A payload can hold text from another service. */
export const SIGNAL_PROMPT_WARNING = 'Payload text is not safe: the host marks it as data, but that does not make sure that the agent ignores it.'
/** Decision 24 of the plan. */
export const SIGNAL_AGENT_LIMIT_TEXT = 'An action that starts agent work runs at most 30 times in one hour.'

export function emptySignalActionDraft(type: AppSignalActionType = 'notify'): SignalActionDraft {
  return { type, enabled: true, title: '', detail: '', template: '', sessionId: '', automationId: '' }
}

/** The draft of an action the owner changes. */
export function signalActionDraftOf(view: Pick<AppSignalActionView, 'enabled' | 'action'>): SignalActionDraft {
  const draft = { ...emptySignalActionDraft(view.action.type), enabled: view.enabled }
  const { action } = view
  switch (action.type) {
    case 'notify':
      return { ...draft, title: action.title, detail: action.detail }
    case 'send_to_session':
      return { ...draft, template: action.template, sessionId: action.sessionId }
    case 'run_automation':
      return { ...draft, template: action.template, automationId: action.automationId }
  }
}

function refused(error: string): DraftResult<AppSignalAction> {
  return { ok: false, error }
}

/** The action a draft makes, or why it makes none. Only the fields of the chosen type go to the host. */
export function signalActionOf(draft: SignalActionDraft): DraftResult<AppSignalAction> {
  let candidate: AppSignalAction
  switch (draft.type) {
    case 'notify':
      candidate = { type: 'notify', title: draft.title.trim(), detail: draft.detail.trim() }
      break
    case 'send_to_session':
      if (!draft.sessionId.trim()) return refused('Give the ID of the session.')
      candidate = { type: 'send_to_session', template: draft.template, sessionId: draft.sessionId.trim() }
      break
    case 'run_automation':
      if (!draft.automationId) return refused('Choose an automation.')
      candidate = { type: 'run_automation', template: draft.template, automationId: draft.automationId }
      break
  }
  const parsed = appSignalActionSchema.safeParse(candidate)
  if (!parsed.success) return refused(parsed.error.issues[0]?.message ?? 'The action is not valid.')
  return { ok: true, value: parsed.data }
}

/** One line for an action in the list of a signal. */
export function signalActionSummary(action: AppSignalAction, automationName: (automationId: string) => string | undefined = () => undefined): string {
  switch (action.type) {
    case 'notify':
      return action.title ? `Notify me: ${action.title}` : 'Notify me'
    case 'send_to_session':
      return `Send to session ${action.sessionId}`
    case 'run_automation':
      return `Run ${automationName(action.automationId) ?? 'an automation'}`
  }
}

const DELIVERY_STATUS_LABELS = {
  delivered: 'Delivered',
  failed: 'Failed',
  throttled: 'Over the limit',
} satisfies { [Status in AppSignalDelivery['status']]: string }

/** How one action ended for one occurrence: "Notify me · Delivered". */
export function deliveryText(delivery: AppSignalDelivery): string {
  return `${ACTION_TYPE_LABELS[delivery.type]} · ${DELIVERY_STATUS_LABELS[delivery.status]}`
}

/** The newest occurrences of one signal, from the read of every signal of the app. */
export function occurrencesOf(occurrences: readonly AppSignalOccurrence[], signal: string, limit: number): AppSignalOccurrence[] {
  return occurrences.filter((occurrence) => occurrence.name === signal).sort((a, b) => b.emittedAt - a.emittedAt).slice(0, limit)
}

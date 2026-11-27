import { z } from 'zod'
import type { Edge, Node } from '@xyflow/svelte'
import type { AppJsonSchema, AppSignalAction, AppSignalActionView, AppSignalEmitter, AppSignalOccurrence, AppSignalView } from '@solus/contracts/apps'
import { flowEdge } from './flow'
import { deliveryState, type ManageState } from './states'

/**
 * The Signals section (docs/plans/apps.md §9.2): the flow of one signal (what
 * emits it, the signal, its actions) and the rows of its live tail.
 */

export const SIGNAL_EMITTER_WIDTH = 200
export const SIGNAL_EMITTER_HEIGHT = 58
export const SIGNAL_NODE_WIDTH = 240
export const ACTION_NODE_WIDTH = 230
export const ACTION_NODE_HEIGHT = 56
const ACTION_NODE_GAP = 26
/** The space an edge crosses between two columns. */
const COLUMN_GAP = 96
/** Stacked, the space between two rows, and between two actions. */
const ROW_GAP = 32
const STACKED_ACTION_GAP = 13
/** The height the stacked layout keeps for the signal: its payload chips wrap to two lines at most. */
const STACKED_SIGNAL_HEIGHT = 128

/** What emitted the signal's newest occurrence, or null before the first one. */
export type SignalEmitterNodeData = { kind: 'emitter'; emitter: { label: string; name: string } | null }
export type SignalNodeData = { kind: 'signal'; signal: Pick<AppSignalView, 'name' | 'count7d' | 'lastEmittedAt'>; fields: string[] }
/** An action that is off stays on the canvas with its switch; its edge is dashed, as nothing reaches it. */
export type SignalActionNodeData = { kind: 'action'; action: AppSignalActionView }
/** The dashed node that adds an action. */
export type SignalAddNodeData = { kind: 'add' }

export type SignalFlowNode =
  | Node<SignalEmitterNodeData, 'emitter'>
  | Node<SignalNodeData, 'signal'>
  | Node<SignalActionNodeData, 'action'>
  | Node<SignalAddNodeData, 'add'>

export interface SignalFlow {
  nodes: SignalFlowNode[]
  edges: Edge[]
}

export const SIGNAL_EMITTER_NODE_ID = 'emitter'
export const SIGNAL_NODE_ID = 'signal'
export const SIGNAL_ADD_NODE_ID = 'add'

export function signalActionNodeId(actionId: string): string {
  return `action:${actionId}`
}

/**
 * The flow of `signal`, left to right: what emits it, the signal, and a
 * column of its actions and the node that adds one. A position is the left
 * middle of its node (`origin` [0, 0.5]), so the column is centered on the
 * signal whatever height the signal node measures. `isStacked` lays the same
 * nodes top to bottom for a narrow pane; there a position is the top left of
 * its node. A node draws its handles on the sides the layout joins.
 */
export function signalFlow(signal: Pick<AppSignalView, 'name' | 'count7d' | 'lastEmittedAt' | 'payload' | 'emittedBy' | 'actions'>, isStacked = false): SignalFlow {
  const origin: [number, number] = isStacked ? [0, 0] : [0, 0.5]
  const fixed = { origin, draggable: false, connectable: false, selectable: false, focusable: false }
  const actionSize = { width: ACTION_NODE_WIDTH, height: ACTION_NODE_HEIGHT }
  const count = signal.actions.length + 1
  const signalY = SIGNAL_EMITTER_HEIGHT + ROW_GAP
  const actionsY = signalY + STACKED_SIGNAL_HEIGHT + ROW_GAP
  const actionsX = SIGNAL_EMITTER_WIDTH + SIGNAL_NODE_WIDTH + 2 * COLUMN_GAP
  /** The place of the node at `index` of the action column. */
  const actionAt = (index: number) => isStacked
    ? { x: 0, y: actionsY + index * (ACTION_NODE_HEIGHT + STACKED_ACTION_GAP) }
    : { x: actionsX, y: (index - (count - 1) / 2) * (ACTION_NODE_HEIGHT + ACTION_NODE_GAP) }
  /** Stacked, a node narrower than the actions is centered over them. */
  const centered = (width: number) => (ACTION_NODE_WIDTH - width) / 2

  const nodes: SignalFlowNode[] = [
    {
      id: SIGNAL_EMITTER_NODE_ID,
      type: 'emitter',
      position: isStacked ? { x: centered(SIGNAL_EMITTER_WIDTH), y: 0 } : { x: 0, y: 0 },
      data: { kind: 'emitter', emitter: emitterText(signal.emittedBy) },
      width: SIGNAL_EMITTER_WIDTH,
      height: SIGNAL_EMITTER_HEIGHT,
      ...fixed,
    },
    {
      id: SIGNAL_NODE_ID,
      type: 'signal',
      position: isStacked ? { x: centered(SIGNAL_NODE_WIDTH), y: signalY } : { x: SIGNAL_EMITTER_WIDTH + COLUMN_GAP, y: 0 },
      data: { kind: 'signal', signal: { name: signal.name, count7d: signal.count7d, lastEmittedAt: signal.lastEmittedAt }, fields: payloadFields(signal.payload) },
      width: SIGNAL_NODE_WIDTH,
      ...fixed,
    },
    ...signal.actions.map((action, index): SignalFlowNode => ({
      id: signalActionNodeId(action.id), type: 'action', position: actionAt(index), data: { kind: 'action', action }, ...actionSize, ...fixed,
    })),
    { id: SIGNAL_ADD_NODE_ID, type: 'add', position: actionAt(signal.actions.length), data: { kind: 'add' }, ...actionSize, ...fixed },
  ]
  const edges = [
    // Before the first occurrence nothing is known to emit the signal.
    flowEdge(SIGNAL_EMITTER_NODE_ID, SIGNAL_NODE_ID, signal.emittedBy === null),
    ...signal.actions.map((action) => flowEdge(SIGNAL_NODE_ID, signalActionNodeId(action.id), !action.enabled)),
    flowEdge(SIGNAL_NODE_ID, SIGNAL_ADD_NODE_ID, true),
  ]
  return { nodes, edges }
}

/** "Emitted by the operation storeSummary", or null before the first occurrence. */
export function emitterText(emitter: AppSignalEmitter | null): { label: string; name: string } | null {
  if (!emitter) return null
  return { label: emitter.kind === 'workflow' ? 'Emitted by the workflow' : 'Emitted by the operation', name: emitter.name }
}

const jsonObjectSchema = z.record(z.string(), z.json())
const plainValueSchema = z.union([z.string(), z.number(), z.boolean()])

/** The top fields of a payload schema, for the chips of the signal node. */
export function payloadFields(schema: AppJsonSchema, limit = 6): string[] {
  const properties = jsonObjectSchema.safeParse(schema.properties)
  return properties.success ? Object.keys(properties.data).slice(0, limit) : []
}

/** What an action node says of its week. */
export interface ActionCount {
  text: string
  /** Some occurrence did not go: the text shows in the error color. */
  hasFailures: boolean
}

/** "41 sent", "39 sent · 2 failed", or "None this week". */
export function actionCountText(view: Pick<AppSignalActionView, 'delivered7d' | 'failed7d'>): ActionCount {
  if (view.delivered7d === 0 && view.failed7d === 0) return { text: 'None this week', hasFailures: false }
  const sent = `${view.delivered7d} sent`
  return view.failed7d > 0 ? { text: `${sent} · ${view.failed7d} failed`, hasFailures: true } : { text: sent, hasFailures: false }
}

const COLUMN_LABELS = {
  notify: 'Notify',
  send_to_session: 'Session',
  run_automation: 'Automation',
} satisfies { [Type in AppSignalAction['type']]: string }

/** The head of an action's column in the live tail. */
export function actionColumnLabel(action: AppSignalAction): string {
  return COLUMN_LABELS[action.type]
}

/** How one action ended for one occurrence, as a cell of the live tail. */
export interface TailCell {
  text: string
  /** The mark of an action that did not deliver: failed, or warning when it was over the limit. Null when it delivered or did not run. */
  mark: ManageState | null
  /** The session the action sent the prompt to. */
  sessionId: string | null
}

export function tailCell(occurrence: Pick<AppSignalOccurrence, 'deliveries'>, actionId: string): TailCell {
  const delivery = occurrence.deliveries.find((entry) => entry.actionId === actionId)
  if (!delivery) return { text: '—', mark: null, sessionId: null }
  switch (delivery.status) {
    case 'delivered': return { text: 'Sent', mark: null, sessionId: delivery.sessionId ?? null }
    case 'throttled': return { text: 'Over the limit', mark: deliveryState(delivery.status), sessionId: null }
    case 'failed': return { text: delivery.detail ? `Failed · ${delivery.detail}` : 'Failed', mark: deliveryState(delivery.status), sessionId: null }
  }
}

/** "14:31:04" today, "Sat 18:20" in the last week, "Nov 3" before. */
export function tailTime(at: number, now = Date.now()): string {
  const date = new Date(at)
  if (date.toDateString() === new Date(now).toDateString()) return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  if (now - at < 6 * 24 * 60 * 60_000) return `${date.toLocaleDateString(undefined, { weekday: 'short' })} ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** The payload in one line: the first plain values of an object ("sveltejs/kit 2.48.0"), else its JSON. */
export function payloadSummary(payload: string, limit = 3): string {
  let fields: z.infer<typeof jsonObjectSchema> | null = null
  try {
    const parsed = jsonObjectSchema.safeParse(JSON.parse(payload))
    if (parsed.success) fields = parsed.data
  } catch {
    // Not JSON: the text itself.
  }
  const plain = Object.values(fields ?? {}).flatMap((entry) => {
    const value = plainValueSchema.safeParse(entry)
    return value.success ? [String(value.data)] : []
  }).slice(0, limit)
  return plain.length > 0 ? plain.join(' ').slice(0, 160) : payload.slice(0, 160)
}

import { SESSION_ACTION_LEAVES, type SessionActionLeaf } from './permissions'

/**
 * The rows of a custom role (docs/plans/custom-roles.md §4): one per session
 * leaf, with its label, its default on a new link, and the rules between rows.
 * The share dialog on every client draws its rows from this table and the host
 * applies the same rules when it writes a role, so a client cannot store one that
 * breaks them. A new leaf in `SESSION_ACTION_LEAVES` does not compile until it has
 * a row here.
 */
export interface ShareableAction {
  label: string
  /** One line under the label. */
  detail?: string
  /** On for a new link. */
  linkDefault: boolean
  /** Always on: every custom role holds it. */
  locked?: boolean
  /** The row is on only while at least one of these is on. */
  requiresAny?: readonly SessionActionLeaf[]
  /** Shown beside the row while it is on. */
  warning?: string
}

export const SHAREABLE_SESSION_ACTIONS = {
  'read.transcript': { label: 'Watch the session', detail: 'The conversation, the agent’s work, and its plans', linkDefault: true, locked: true },
  'read.diffs': { label: 'See changes', detail: 'The diffs the agent made', linkDefault: true },
  'read.files': { label: 'See files', detail: 'Every file in the session’s checkout', linkDefault: false },
  'drive.propose': { label: 'Suggest messages', detail: 'Someone who can prompt sends or dismisses each one', linkDefault: true },
  'drive.prompt': { label: 'Prompt directly', detail: 'Send turns, stop them, and change the queue', linkDefault: false },
  'drive.attach': { label: 'Attach files', detail: 'With a suggestion or a prompt', linkDefault: true, requiresAny: ['drive.propose', 'drive.prompt'] },
  'drive.approve': {
    label: 'Approve tools and answer questions',
    detail: 'What the agent may run, its questions, and its plans',
    linkDefault: false,
    requiresAny: ['drive.prompt'],
    warning: 'This lets them run commands on this computer.',
  },
  'drive.devices': { label: 'Use devices', detail: 'Simulators and phones connected to this computer', linkDefault: false, requiresAny: ['drive.prompt'] },
  'drive.apps': { label: 'Use app panels', detail: 'Interactive panels from the agent’s tools', linkDefault: false, requiresAny: ['drive.prompt'] },
} as const satisfies Record<SessionActionLeaf, ShareableAction>

/**
 * The custom role these leaves make: the locked rows added, a row whose
 * requirement is off removed, duplicates gone, in table order. The host stores
 * only this; the dialog shows it.
 */
export function customRoleActions(chosen: readonly SessionActionLeaf[]): SessionActionLeaf[] {
  const held = new Set<SessionActionLeaf>(chosen)
  for (const leaf of SESSION_ACTION_LEAVES) {
    const row: ShareableAction = SHAREABLE_SESSION_ACTIONS[leaf]
    if (row.locked) held.add(leaf)
  }
  return SESSION_ACTION_LEAVES.filter((leaf) => {
    if (!held.has(leaf)) return false
    const row: ShareableAction = SHAREABLE_SESSION_ACTIONS[leaf]
    const requires = row.requiresAny
    return !requires || requires.some((other) => held.has(other))
  })
}

/** What a new link holds before its sharer changes anything. */
export const DEFAULT_LINK_ACTIONS: readonly SessionActionLeaf[] = customRoleActions(
  SESSION_ACTION_LEAVES.filter((leaf) => SHAREABLE_SESSION_ACTIONS[leaf].linkDefault),
)

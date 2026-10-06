// Adapted from T3 Code apps/mobile/src/features/threads/composerSendPresentation.ts (MIT, see UPSTREAM.md).

/**
 * What a message sent during a running turn does. Solus offers two: steer the
 * live turn, or queue after it. T3's third, restart, has no Solus counterpart.
 */
export type ActiveTurnComposerAction = 'queue' | 'steer'

export interface ComposerSendPresentation {
  readonly label: string
  readonly icon: 'arrow.up' | 'list.number' | 'arrow.turn.left.up'
  /** What a plain tap does while a turn runs, or null when the turn is idle. */
  readonly action: ActiveTurnComposerAction | null
  /** What the long-press menu does instead. */
  readonly alternate: ActiveTurnComposerAction | null
  /** The follow-up menu is meaningless outside a running turn. */
  readonly offersFollowUpChoice: boolean
}

const ACTION_LABEL: Record<ActiveTurnComposerAction, string> = {
  queue: 'Queue',
  steer: 'Steer',
}

function alternateComposerDispatchAction(action: ActiveTurnComposerAction): ActiveTurnComposerAction {
  return action === 'steer' ? 'queue' : 'steer'
}

/**
 * What the composer's primary button says and does. Steering is only offered
 * when the turn can actually be steered (Solus: a running turn), so the button
 * never promises something the host would have to downgrade.
 */
export function resolveComposerSendPresentation(input: {
  readonly running: boolean
  readonly canSteer: boolean
  /** What a follow-up does by default; Solus steers. */
  readonly followUpBehavior: ActiveTurnComposerAction
  /** Reasons the send waits rather than leaving immediately (a held queue, no connection). */
  readonly deliveryDeferred: boolean
}): ComposerSendPresentation {
  if (!input.running) {
    return {
      label: input.deliveryDeferred ? 'Queue' : 'Send',
      icon: 'arrow.up',
      action: null,
      alternate: null,
      offersFollowUpChoice: false,
    }
  }
  // Without steering support the choice collapses: every follow-up queues.
  const action: ActiveTurnComposerAction = input.canSteer && !input.deliveryDeferred ? input.followUpBehavior : 'queue'
  return {
    label: ACTION_LABEL[action],
    icon: action === 'steer' ? 'arrow.turn.left.up' : 'list.number',
    action,
    alternate: input.canSteer && !input.deliveryDeferred ? alternateComposerDispatchAction(action) : null,
    offersFollowUpChoice: input.canSteer && !input.deliveryDeferred,
  }
}

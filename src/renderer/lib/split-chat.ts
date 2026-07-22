import type { Session, Tab } from '../../shared/types'

export function isPristineSplitTab(tab: Tab, session: Session): boolean {
  return !session.agentSessionId
    && session.status === 'idle'
    && session.messages.length === 0
    && !session.statusCard
    && session.permissionQueue.length === 0
    && session.questionQueue.length === 0
    && session.serverQueuedPrompts.length === 0
    && tab.input.text.length === 0
    && tab.input.attachments.length === 0
    && tab.input.planRefs.length === 0
    && tab.input.workRefs.length === 0
}

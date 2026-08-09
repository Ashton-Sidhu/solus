import type { Session, Tab } from '../../shared/types'

export function isPristineSplitTab(tab: Tab, session: Session): boolean {
  return !session.agentSessionId
    && session.status === 'idle'
    && session.messages.length === 0
    && !session.statusCard
    && session.permissionQueue.length === 0
    && session.questionQueue.length === 0
    && session.outboundPrompts.length === 0
    && session.prompt.text.length === 0
    && session.prompt.attachments.length === 0
    && session.prompt.planRefs.length === 0
    && session.prompt.workRefs.length === 0
    && session.prompt.sessionRefs.length === 0
}

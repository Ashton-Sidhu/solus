import type { SessionTreeRelation } from '@solus/contracts/session-digest'
import type { SessionRecord } from '@solus/contracts/types'
import type { RecordScope } from '../../admission/principal'
import { sessionForkActivity } from '../activity/activity'
import { providerThreadsOf, sessionIdOfThread } from './session-lineage'
import { getSessionRecords } from './session-records'

export async function forkActivityOf(scope: RecordScope, sessionId: string) {
  return sessionForkActivity(scope, sessionId, [sessionId, ...providerThreadsOf(sessionId)])
}

export function treeRelation(kind: SessionTreeRelation['kind'], record: SessionRecord): SessionTreeRelation {
  return {
    kind,
    sessionId: record.sessionId,
    title: record.customTitle?.trim() || record.title?.trim() || 'Untitled session',
    runnerHostId: record.runnerHostId,
  }
}

export async function sessionTreeRelations(scope: RecordScope, root: SessionRecord): Promise<SessionTreeRelation[]> {
  const links = new Map<string, SessionTreeRelation['kind']>()
  if (root.parentSessionId) links.set(root.parentSessionId, 'parent')
  for (const fork of await forkActivityOf(scope, root.sessionId)) {
    if (fork.subject.id === root.sessionId) links.set(sessionIdOfThread(fork.sourceSessionId), 'fork-source')
    else if (!links.has(fork.subject.id)) links.set(fork.subject.id, 'fork')
  }
  links.delete(root.sessionId)
  const records = await getSessionRecords(scope, [...links.keys()])
  return [...links].flatMap(([id, kind]) => {
    const record = records.get(id)
    return record ? [treeRelation(kind, record)] : []
  })
}

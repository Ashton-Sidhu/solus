import { formatSessionCloudScope } from '@solus/contracts/session-repositories'
import type { SessionRecord } from '@solus/contracts/types'
import { isOrganizationWork } from '../../data/sessions/session-records'

/** A new host has no local record, so its first read uses the acting person's scope. */
export function sessionCloudScope(record: SessionRecord | null, accountId: string) {
  return record && isOrganizationWork(record)
    ? formatSessionCloudScope('organization', record.organizationId)
    : formatSessionCloudScope('person', accountId)
}

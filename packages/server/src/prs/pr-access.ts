import { standingAllows } from '@solus/contracts/permissions'
import type { ResourceAccess } from '../admission/access-policy'
import type { Principal } from '../admission/principal'
import { sessionsOfPullRequest } from '../data/sessions/session-pull-requests'

/** A linked pull request requires edit access to one of its sessions, in
 * addition to host.git.write. An unlinked pull request belongs to its repository. */
export async function assertMayChangePullRequest(
  caller: { principal: Principal; resources: ResourceAccess },
  repository: string,
  number: number,
): Promise<void> {
  const ids = await sessionsOfPullRequest(repository, number)
  if (!ids.length) return
  const standings = await Promise.all(ids.map((id) => caller.resources.standingFor(caller.principal, { kind: 'session', id })))
  if (!standings.some((standing) => standingAllows(standing, 'edit'))) {
    throw new Error('This pull request is part of a session you cannot change.')
  }
}

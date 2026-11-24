import { isAbsoluteHostPath } from '@solus/contracts/host-path'
import type { ProjectRef } from '../../../contexts/projects/project-catalog'
import type { ListProjectOption } from '../../ui/list-page/list-page'

/** Use the viewed checkout when it belongs to this scope and can start a session. */
export function scopedNewCheckout(
  scope: ListProjectOption,
  checkouts: readonly ProjectRef[],
  viewedHostId: string | undefined,
  canStart: (serverId: string) => boolean,
): ProjectRef | undefined {
  const fallback = { serverId: scope.serverId, projectRoot: scope.projectKey }
  const options = checkouts.length ? checkouts : scope.available ? [fallback] : []
  const eligible = options.filter(({ serverId, projectRoot }) => isAbsoluteHostPath(projectRoot) && canStart(serverId))
  return eligible.find(({ serverId }) => serverId === viewedHostId) ?? eligible[0]
}

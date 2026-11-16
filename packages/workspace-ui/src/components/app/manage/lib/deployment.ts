import { deploymentState, type SubjectDirectory } from '@solus/client-core/app-deployment'
import type { AppDeploymentView } from '@solus/contracts/app-deployments'
import { userKey } from '@solus/contracts/user'
import type { OrganizationPeople } from '../../../users/lib/organization-people'
import type { ManageState } from './states'

const DEPLOYMENT_MARKS = {
  running: 'ok',
  'not-answering': 'warning',
  stopped: 'stopped',
  'host-unreachable': 'warning',
} satisfies { [State in ReturnType<typeof deploymentState>]: ManageState }

/** The mark of the Manage page for how the published copy is. */
export function deploymentMark(deployment: Pick<AppDeploymentView, 'running' | 'status' | 'host'>): ManageState {
  return DEPLOYMENT_MARKS[deploymentState(deployment)]
}

/** The organization's people and teams, as the list of who opens a published app names them. */
export function subjectDirectoryOf(people: OrganizationPeople | null): SubjectDirectory | null {
  if (!people) return null
  return {
    organization: { id: people.organizationId, name: people.name },
    teams: people.teams.map((team) => ({ id: team.teamId, name: team.name, memberCount: team.memberUserIds.length })),
    members: people.members.map((member) => ({ id: userKey(member.id), name: member.displayName, email: member.email })),
  }
}

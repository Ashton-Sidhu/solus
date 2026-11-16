import type { HostApi } from '@solus/client-core/host-api'
import { safeProjectDirName } from '@solus/contracts/project-folder-name'
import { projectContext } from '../../conversation/lib/ipc-context'
import { publishProjectFailure } from './open-project'

export type CreateProjectOutcome =
  | { kind: 'ready'; path: string }
  | { kind: 'unpublished'; path: string; error: string }

/** Preserve the local project when publishing fails, so Retry never creates it twice. */
export async function createProject(api: Pick<HostApi, 'setupCreateProject' | 'githubPublishRepository'>, input: {
  readonly name: string;
  readonly existingPath: string | null;
  readonly publishes: boolean;
  readonly organizationId: string | null;
}): Promise<CreateProjectOutcome> {
  const name = input.name.trim()
  if (!name) throw new Error('Name the project.')
  const path = input.existingPath ?? (await api.setupCreateProject({ name })).path
  if (!input.publishes) return { kind: 'ready', path }
  try {
    const result = await api.githubPublishRepository(projectContext(path, input.organizationId), {
      name: safeProjectDirName(name), private: true, protocol: 'https',
    })
    const error = publishProjectFailure(result)
    return error ? { kind: 'unpublished', path, error } : { kind: 'ready', path }
  } catch (cause) {
    return { kind: 'unpublished', path, error: cause instanceof Error ? cause.message : String(cause) }
  }
}

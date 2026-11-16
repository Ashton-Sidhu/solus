import { describe, expect, test } from 'bun:test'
import type { HostApi } from '@solus/client-core/host-api'
import type { GithubPublishRepositoryResult } from '@solus/contracts/types'
import { createProject } from '../../apps/mobile/src/features/projects/lib/create-project'

const published: GithubPublishRepositoryResult = {
  success: true,
  repository: { status: 'created', url: 'https://github.com/me/My-App', fullName: 'me/My-App' },
  remote: { status: 'added', name: 'origin', url: 'https://github.com/me/My-App.git' },
  push: { status: 'skipped_no_commits' },
}

describe('creating a project with optional publishing', () => {
  test('an empty project stays local unless publishing was selected', async () => {
    const result = await createProject({
      setupCreateProject: async (request) => {
        expect(request).toEqual({ name: 'My App' })
        return { path: '/projects/My-App', projectKey: 'key' }
      },
      githubPublishRepository: async () => { throw new Error('Must not publish a local-only project') },
    }, { name: ' My App ', existingPath: null, publishes: false, organizationId: null })
    expect(result).toEqual({ kind: 'ready', path: '/projects/My-App' })
  })

  test('publishing uses the host-resolved project path, organization, and private visibility', async () => {
    const result = await createProject({
      setupCreateProject: async () => ({ path: 'C:\\code\\My-App', projectKey: 'key' }),
      githubPublishRepository: async (context, request) => {
        expect(context.session.workingDirectory).toBe('C:\\code\\My-App')
        expect(context.session.organizationId).toBe('org-a')
        expect(request).toEqual({ name: 'My-App', private: true, protocol: 'https' })
        return published
      },
    }, { name: 'My App', existingPath: null, publishes: true, organizationId: 'org-a' })
    expect(result.kind).toBe('ready')
  })

  test('a refused publish retains the local project, and retry does not create another folder', async () => {
    let creates = 0
    let attempts = 0
    const api: Pick<HostApi, 'setupCreateProject' | 'githubPublishRepository'> = {
      setupCreateProject: async () => { creates++; return { path: '/p/app', projectKey: 'key' } },
      githubPublishRepository: async () => {
        attempts++
        return attempts === 1 ? { ...published, success: false, remote: { status: 'failed', error: 'Could not add origin' } } : published
      },
    }
    const input = { name: 'app', existingPath: null, publishes: true, organizationId: null }
    const failed = await createProject(api, input)
    expect(failed).toEqual({ kind: 'unpublished', path: '/p/app', error: 'Could not add origin' })
    const retry = await createProject(api, { ...input, existingPath: failed.path })
    expect(retry).toEqual({ kind: 'ready', path: '/p/app' })
    expect([creates, attempts]).toEqual([1, 2])
  })

  test('a network failure during publishing still keeps the created project available', async () => {
    const result = await createProject({
      setupCreateProject: async () => ({ path: '/p/app', projectKey: 'key' }),
      githubPublishRepository: async () => { throw new Error('Host disconnected') },
    }, { name: 'app', existingPath: null, publishes: true, organizationId: null })
    expect(result).toEqual({ kind: 'unpublished', path: '/p/app', error: 'Host disconnected' })
  })
})

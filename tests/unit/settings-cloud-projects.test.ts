import { describe, expect, test } from 'bun:test'
import { checkoutHostsOf, cloudProjectSuggestions } from '@solus/workspace-ui/components/settings/lib/cloud-projects'

const cloudProject = { id: 'p1', repositoryKey: 'github.com/acme/web', displayName: 'acme/web', defaultBranch: null, createdBy: null, createdAt: 0 }
const checkout = (serverId: string, projectRoot: string, repositoryKey: string | null, lastSeenAt = 1) =>
  ({ serverId, projectRoot, label: projectRoot, lastSeenAt, repositoryKey })

describe('Settings cloud projects', () => {
  test('suggests each repository on your machines that is not a cloud project yet, once', () => {
    // WHY: adding a project is explicit (project-model §2); the suggestions make
    // it one click without ever adding a folder with no hosted remote.
    const suggestions = cloudProjectSuggestions([
      checkout('laptop', '/Users/me/web', 'github.com/acme/web'),
      checkout('laptop', '/Users/me/api', 'github.com/acme/api', 2),
      checkout('linux', '/home/me/api', 'github.com/acme/api'),
      checkout('laptop', '/Users/me/scratch', null),
    ], [cloudProject])
    expect(suggestions).toEqual([{ repositoryKey: 'github.com/acme/api', label: 'acme/api' }])
  })

  test('names every machine holding a checkout of the project, each once', () => {
    expect(checkoutHostsOf(cloudProject, [
      checkout('laptop', '/Users/me/web', 'github.com/acme/web'),
      checkout('laptop', '/Users/me/web-2', 'github.com/acme/web'),
      checkout('linux', '/home/me/web', 'github.com/acme/web'),
      checkout('linux', '/home/me/api', 'github.com/acme/api'),
    ])).toEqual(['laptop', 'linux'])
  })
})

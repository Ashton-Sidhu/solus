import { describe, expect, test } from 'bun:test'
import type { ProviderRepository } from '@solus/contracts/providers'
import { repositoryKeyOf, repositoryRows, REPOSITORY_ROWS } from '@solus/workspace-ui/components/onboarding/lib/onboarding-repositories'

// The project stage (docs/plans/cloud-onboarding.md §3.4): a project is a repository,
// named by the same key project identity uses everywhere.

function repository(owner: string, repo: string, pushedAt: string | null, isPrivate = false): ProviderRepository {
  return { host: 'github.com', owner, repo, pushedAt, isPrivate }
}

describe('cloud onboarding: choosing a project', () => {
  test('a repository is keyed the way project identity keys it', () => {
    expect(repositoryKeyOf(repository('Acme', 'Web', null))).toBe('github.com/acme/web')
  })

  test('the organization’s projects come first and are not listed twice', () => {
    const rows = repositoryRows(
      [{ repositoryKey: 'github.com/acme/api', displayName: 'api' }],
      [repository('acme', 'api', '2026-09-20T00:00:00Z'), repository('acme', 'web', '2026-09-21T00:00:00Z', true)],
      '',
    )
    expect(rows.map((row) => [row.repositoryKey, row.isProject])).toEqual([
      ['github.com/acme/api', true],
      ['github.com/acme/web', false],
    ])
    expect(rows[1].detail).toBe('Private repository')
  })

  test('repositories are listed most recently pushed first, and search narrows them', () => {
    const repositories = [
      repository('acme', 'old', '2025-01-01T00:00:00Z'),
      repository('acme', 'new', '2026-09-01T00:00:00Z'),
      repository('acme', 'never', null),
    ]
    expect(repositoryRows([], repositories, '').map((row) => row.name)).toEqual(['acme/new', 'acme/old', 'acme/never'])
    expect(repositoryRows([], repositories, 'OLD').map((row) => row.name)).toEqual(['acme/old'])
  })

  test('the list stays short enough to read', () => {
    const many = Array.from({ length: 20 }, (_, index) => repository('acme', `repo-${index}`, null))
    expect(repositoryRows([], many, '')).toHaveLength(REPOSITORY_ROWS)
  })
})

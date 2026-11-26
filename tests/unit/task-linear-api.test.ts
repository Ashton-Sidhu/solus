import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { linearCategory, linearRequest } from '@solus/server/data/tasks/providers/linear-api'
import {
  parseIssueKey,
  issueKey,
  issueSourceKey
} from '@solus/contracts/task-sources'
import { linearRefSchema, vaultSaveKeyRequestSchema, materialKindsOf } from '@solus/contracts/vault'

const schema = z.object({ viewer: z.object({ name: z.string() }) })
describe('Linear transport and identity', () => {
  test('sends a personal key only to the fixed endpoint without redirects', async () => {
    const fetcher: typeof fetch = async (input, init) => {
      expect(String(input)).toBe('https://api.linear.app/graphql')
      expect(new Headers(init?.headers).get('authorization')).toBe('fixture-key')
      expect(init?.redirect).toBe('error')
      expect(JSON.parse(String(init?.body))).toEqual({
        query: 'query { viewer { name } }',
        variables: {}
      })
      return Response.json({ data: { viewer: { name: 'Ada' } } })
    }
    expect(
      await linearRequest('query { viewer { name } }', {}, schema, 'fixture-key', fetcher)
    ).toEqual({ viewer: { name: 'Ada' } })
  })
  test('a GraphQL error with HTTP 200 cannot appear as a successful write', async () => {
    await expect(
      linearRequest('mutation {}', {}, schema, 'fixture-key', async () =>
        Response.json({ data: null, errors: [{ message: 'Permission denied' }] })
      )
    ).rejects.toThrow('Permission denied')
  })
  test.each([
    [401, 'reconnect'],
    [403, 'no_access'],
    [429, 'error']
  ] as const)('HTTP %s has an actionable failure', async (status, health) => {
    await expect(
      linearRequest(
        'query {}',
        {},
        schema,
        'fixture-key',
        async () => new Response(null, { status })
      )
    ).rejects.toMatchObject({ health })
  })
  test('a task and team keep workspace identity and use the account key contract', () => {
    const ref = { provider: 'linear', workspaceId: 'workspace-a', id: 'issue-id' } as const
    expect(parseIssueKey(issueKey(ref))).toEqual(ref)
    expect(
      issueSourceKey({
        kind: 'linear-team',
        workspaceId: 'workspace-a',
        teamId: 'team',
        teamKey: 'APP'
      })
    ).not.toBe(
      issueSourceKey({
        kind: 'linear-team',
        workspaceId: 'workspace-b',
        teamId: 'team',
        teamKey: 'APP'
      })
    )
    const credential = linearRefSchema.parse({ kind: 'provider', provider: 'linear' })
    expect(materialKindsOf(credential)).toEqual(['key'])
    expect(vaultSaveKeyRequestSchema.parse({ ref: credential, key: 'fixture-key' }).ref).toEqual(
      credential
    )
    expect(linearCategory('completed')).toBe('done')
    expect(linearCategory('canceled')).toBe('done')
    expect(linearCategory('started')).toBe('active')
  })

})

import { expect, test } from 'bun:test'
import {
  formatSessionCloudScope, parseSessionCloudScope, sessionCloudScopeSchema,
  sessionRepositoryHeadRefusalSchema, sessionRepositoryHeadResponseSchema,
} from '@solus/contracts/session-repositories'

// WHY: a personal session must not enter an organization repository through an invalid scope.
test('cloud scope parses and formats only a person or organization id', () => {
  expect(formatSessionCloudScope('person', 'account-1')).toBe('person:account-1')
  expect(parseSessionCloudScope('organization:org-1')).toEqual({ kind: 'organization', id: 'org-1' })
  expect(parseSessionCloudScope('person:')).toBeNull()
  expect(sessionCloudScopeSchema.safeParse('team:org-1').success).toBe(false)
})

// WHY: an older host must learn the accepted head when its report loses the turn-count race.
test('head conflict is a refusal shape, not a successful report', () => {
  const conflict = { head: 'a'.repeat(40) }
  expect(sessionRepositoryHeadRefusalSchema.parse(conflict)).toEqual(conflict)
  expect(sessionRepositoryHeadResponseSchema.safeParse(conflict).success).toBe(false)
})

// WHY: the API worker and generated reference must use the same route and response contract.
test('personal session list is registered in the API and OpenAPI', async () => {
  const { LIST_MY_SESSIONS_PATH } = await import('@solus/contracts/session-repositories')
  const { solusApiOperations } = await import('@solus/contracts/solus-api/operations')
  const { solusApiOpenApi } = await import('@solus/contracts/solus-api/openapi')
  expect('/v1' + solusApiOperations.listMySessions.path).toBe(LIST_MY_SESSIONS_PATH)
  expect(solusApiOperations.listMySessions.scope).toBe('sessions:read')
  expect(solusApiOpenApi().paths[LIST_MY_SESSIONS_PATH]?.get.operationId).toBe('listMySessions')
})

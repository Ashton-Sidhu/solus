import { describe, expect, test } from 'bun:test'
import { hostPolicyAssignmentPath, hostPolicyPath, organizationPolicyPath, type OrganizationPolicyResponse } from '@solus/contracts/policy-api'
import { settingsCloudRequests, type SettingsHttpRequest } from '@solus/client-core/settings-requests'

// plans/030 §5.2: every client reads the policy API the same way, so a status
// means one thing on desktop, web, and mobile.

const organization: OrganizationPolicyResponse = {
  organizationId: 'acme',
  name: 'Acme',
  canManage: true,
  revision: 2,
  document: { schemaVersion: 1, organization: { name: 'Acme' } },
  updatedAt: 1,
}

function requestsAnswering(response: Response | null | 'signed-out') {
  const sent: SettingsHttpRequest[] = []
  const requests = settingsCloudRequests(async (request) => {
    sent.push(request)
    return response
  })
  return { requests, sent }
}

describe('policy API results', () => {
  test('a read decodes the response, and a body the schema refuses is an error, not a guess', async () => {
    expect(await requestsAnswering(Response.json(organization)).requests.organizationPolicyGet('acme')).toEqual({ kind: 'ok', value: organization })
    expect(await requestsAnswering(Response.json({ revision: 'x' })).requests.organizationPolicyGet('acme'))
      .toEqual({ kind: 'error', code: 'invalid_response', message: null })
  })

  test('409 is a conflict that carries what the other owner saved', async () => {
    const answer = Response.json({ error: 'policy_conflict', revision: 5, document: { schemaVersion: 1 } }, { status: 409 })
    const { requests, sent } = requestsAnswering(answer)
    const write = { expectedRevision: 2, document: organization.document }
    expect(await requests.organizationPolicyPut('acme', write)).toEqual({ kind: 'conflict', revision: 5, document: { schemaVersion: 1 } })
    expect(sent).toEqual([{ method: 'PUT', path: organizationPolicyPath('acme'), body: write }])
  })

  test('422 is a rejection with its issues', async () => {
    const answer = Response.json({ error: 'host_owned_by_other_organization', issues: ['Globex manages this host.'] }, { status: 422 })
    expect(await requestsAnswering(answer).requests.hostPolicyAssign('acme', 'host-1', { policyId: 'p1' }))
      .toEqual({ kind: 'rejected', reason: 'host_owned_by_other_organization', issues: ['Globex manages this host.'] })
  })

  test('403 and 404 are forbidden; 401 and no session are signed out; no answer is offline', async () => {
    expect(await requestsAnswering(new Response(null, { status: 403 })).requests.hostPoliciesGet('acme')).toEqual({ kind: 'forbidden' })
    expect(await requestsAnswering(new Response(null, { status: 404 })).requests.hostPoliciesGet('acme')).toEqual({ kind: 'forbidden' })
    expect(await requestsAnswering(new Response(null, { status: 401 })).requests.hostPoliciesGet('acme')).toEqual({ kind: 'signed-out' })
    expect(await requestsAnswering('signed-out').requests.hostPoliciesGet('acme')).toEqual({ kind: 'signed-out' })
    expect(await requestsAnswering(null).requests.hostPoliciesGet('acme')).toEqual({ kind: 'offline' })
  })

  test('a delete needs no body, and each call goes to its own route', async () => {
    const { requests, sent } = requestsAnswering(new Response(null, { status: 204 }))
    expect(await requests.hostPolicyDelete('acme', 'p1')).toEqual({ kind: 'ok', value: null })
    await requests.hostPolicyUnassign('acme', 'host-1')
    expect(sent.map((request) => `${request.method} ${request.path}`)).toEqual([
      `DELETE ${hostPolicyPath('acme', 'p1')}`,
      `DELETE ${hostPolicyAssignmentPath('acme', 'host-1')}`,
    ])
  })
})

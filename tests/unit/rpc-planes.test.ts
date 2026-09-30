import { describe, expect, test } from 'bun:test'
import { RPC_INVOKE_METHODS } from '@solus/contracts/rpc'
import { RPC_PLANES, rpcPlaneOf } from '@solus/contracts/rpc-planes'
import { INTERNAL_HANDLER_CTX, SolusServer } from '@solus/server/transport/server'
import { PlaneDisabledError, resolveRoles } from '@solus/server/host/roles'
import { TEST_HANDLER_CTX } from './helpers/handler-ctx'

// docs/plans/cloud-service-model.md: every method sits on exactly one plane, and a
// host answers only for the planes its roles name. A method missing from the map
// would be served by every host, which is the leak the classification exists to stop.

describe('the plane map', () => {
  test('classifies every registered method and nothing else', () => {
    expect(Object.keys(RPC_PLANES).sort()).toEqual([...RPC_INVOKE_METHODS].sort())
    for (const method of RPC_INVOKE_METHODS) expect(['collaboration', 'execution']).toContain(rpcPlaneOf(method))
  })

  test('records are collaboration; a checkout or an agent process is execution', () => {
    expect(rpcPlaneOf('tasksComment')).toBe('collaboration')
    expect(rpcPlaneOf('loadWorkRevisions')).toBe('collaboration')
    expect(rpcPlaneOf('shareSet')).toBe('collaboration')
    expect(rpcPlaneOf('prList')).toBe('collaboration')
    expect(rpcPlaneOf('prompt')).toBe('execution')
    expect(rpcPlaneOf('gitRunAction')).toBe('execution')
    // A pull request's diff comes from its code host, never a checkout, so a
    // client whose only connection is the workspace service can still read it.
    expect(rpcPlaneOf('prGetDiff')).toBe('collaboration')
    expect(rpcPlaneOf('prInterdiff')).toBe('execution')
    // Provider seat login runs on the execution host (seat-handlers.ts).
    expect(rpcPlaneOf('seatConnectStart')).toBe('execution')
  })
})

describe('SOLUS_ROLES', () => {
  test('unset means both planes; a list names the planes served; a typo is refused', () => {
    expect([...resolveRoles({})].sort()).toEqual(['collaboration', 'execution'])
    expect([...resolveRoles({ SOLUS_ROLES: 'collaboration' })]).toEqual(['collaboration'])
    expect([...resolveRoles({ SOLUS_ROLES: ' execution , collaboration ' })].sort()).toEqual(['collaboration', 'execution'])
    expect(() => resolveRoles({ SOLUS_ROLES: 'runner' })).toThrow(/unknown role/)
  })

  test('a host refuses a method on a plane it does not serve with PLANE_DISABLED, and serves the rest', async () => {
    const server = new SolusServer()
    server.register('tasksSidebarSnapshot', async () => ({ tasks: [], sessionsByTask: {} }))
    server.register('gitRefreshState', async () => undefined)
    server.useRoles(resolveRoles({ SOLUS_ROLES: 'collaboration' }))

    await expect(server.handle('tasksSidebarSnapshot', [], TEST_HANDLER_CTX)).resolves.toEqual({ tasks: [], sessionsByTask: {} })
    const refusal = server.handle('gitRefreshState', ['/repo'], TEST_HANDLER_CTX)
    await expect(refusal).rejects.toBeInstanceOf(PlaneDisabledError)
    await expect(refusal).rejects.toMatchObject({ code: 'PLANE_DISABLED', plane: 'execution' })
  })

  test('the host calling itself is not gated', async () => {
    // WHY: capability probes dispatch internally; a collaboration-only host must still boot.
    const server = new SolusServer()
    server.register('detectEditors', async () => ({ editors: [] }))
    server.useRoles(resolveRoles({ SOLUS_ROLES: 'collaboration' }))
    await expect(server.handle('detectEditors', [], INTERNAL_HANDLER_CTX)).resolves.toEqual({ editors: [] })
  })
})

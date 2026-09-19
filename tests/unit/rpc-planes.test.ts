import { describe, expect, test } from 'bun:test'
import { RPC_INVOKE_METHODS } from '@solus/contracts/rpc'
import { RPC_PLANES, rpcPlaneOf } from '@solus/contracts/rpc-planes'
import { INTERNAL_HANDLER_CTX, SolusServer } from '@solus/server/server/server'
import { PlaneDisabledError, resolveRoles } from '@solus/server/server/roles'
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
    expect(rpcPlaneOf('tasksCreate')).toBe('collaboration')
    expect(rpcPlaneOf('loadWork')).toBe('collaboration')
    expect(rpcPlaneOf('shareSet')).toBe('collaboration')
    expect(rpcPlaneOf('prList')).toBe('collaboration')
    expect(rpcPlaneOf('prompt')).toBe('execution')
    expect(rpcPlaneOf('gitRunAction')).toBe('execution')
    expect(rpcPlaneOf('prGetDiff')).toBe('execution')
    // A credential is connected where it is kept (cloud-service-model.md §5): the
    // workspace service relays the CLI login and stores the result in the vault.
    expect(rpcPlaneOf('seatConnectStart')).toBe('collaboration')
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
    server.register('tasksList', async () => ({ tasks: [] }))
    server.register('gitRefreshState', async () => undefined)
    server.useRoles(resolveRoles({ SOLUS_ROLES: 'collaboration' }))

    await expect(server.handle('tasksList', [{}], TEST_HANDLER_CTX)).resolves.toEqual({ tasks: [] })
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

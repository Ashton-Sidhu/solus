import { RPC_INVOKE_METHODS } from '../../../src/shared/rpc'
import type { DemoBackend } from './server'
import { createNoHostSolusApi } from '@client-core/no-host-api'
import { asHostApi, type HostApi } from '@client-core/host-api'

export function createDemoSolusApi(backend: DemoBackend): HostApi {
  const api = createNoHostSolusApi()

  for (const method of RPC_INVOKE_METHODS) {
    Reflect.set(api, method, (...args: unknown[]) => backend.handle(method, args))
  }

  Reflect.set(api, 'transcribeAudio', async () => '')
  Reflect.set(api, 'attachFiles', async () => null)
  Reflect.set(api, 'uploadFiles', async () => null)

  return asHostApi(api)
}

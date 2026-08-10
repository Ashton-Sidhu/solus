import { RPC_INVOKE_METHODS } from '../../../src/shared/rpc'
import type { DemoBackend } from './server'
import { createNoHostSolusApi } from '@client-core/no-host-api'
import { asHostApi, type HostApi } from '@client-core/host-api'

export function createDemoSolusApi(backend: DemoBackend): HostApi {
  const api = createNoHostSolusApi()
  const methods = api as unknown as Record<string, unknown>

  for (const method of RPC_INVOKE_METHODS) {
    methods[method] = (...args: unknown[]) => backend.handle(method, args)
  }

  methods.transcribeAudio = async () => ''
  methods.attachFiles = async () => null
  methods.uploadFiles = async () => null

  return asHostApi(api)
}
